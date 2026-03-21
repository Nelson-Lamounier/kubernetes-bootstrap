#!/usr/bin/env python3
"""persist-tls-cert.py — Back up / restore TLS certificates via SSM Parameter Store.

Prevents Let's Encrypt rate-limit exhaustion on instance replacement by
persisting the issued certificate + private key to SSM SecureString *after*
cert-manager successfully issues it, and restoring it *before* cert-manager
starts on the next bootstrap.

Modes:
  --backup   Read the K8s Secret → store in SSM (run after cert is Ready)
  --restore  Read SSM → create K8s Secret (run before cert-manager syncs)

SSM Parameter: {ssm_prefix}/tls/{secret_name}
  Stored as JSON: {"tls.crt": "<base64>", "tls.key": "<base64>"}

Usage:
  python3 persist-tls-cert.py --backup  --secret ops-tls-cert --namespace kube-system
  python3 persist-tls-cert.py --restore --secret ops-tls-cert --namespace kube-system
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import subprocess
import sys
from pathlib import Path


# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
SSM_PREFIX = os.environ.get("SSM_PREFIX", "/k8s/development")
AWS_REGION = os.environ.get("AWS_REGION", "eu-west-1")
KUBECONFIG = os.environ.get("KUBECONFIG", "/etc/kubernetes/admin.conf")


def log(msg: str) -> None:
    """Print a log message with immediate flush."""
    print(msg, flush=True)


def get_ssm_client():
    """Create a boto3 SSM client."""
    import boto3
    return boto3.client("ssm", region_name=AWS_REGION)


def ssm_param_path(secret_name: str) -> str:
    """Build the SSM parameter path for a TLS secret."""
    return f"{SSM_PREFIX}/tls/{secret_name}"


# ---------------------------------------------------------------------------
# Backup: K8s Secret → SSM
# ---------------------------------------------------------------------------
def backup_cert(secret_name: str, namespace: str, dry_run: bool = False) -> bool:
    """Read a kubernetes.io/tls Secret and store its data in SSM.

    Args:
        secret_name: Name of the K8s Secret to back up.
        namespace: K8s namespace containing the Secret.
        dry_run: If True, print actions without executing.

    Returns:
        True if backup succeeded, False otherwise.
    """
    log(f"=== TLS Cert Backup: {namespace}/{secret_name} → SSM ===")

    # 1. Read the K8s Secret
    result = subprocess.run(
        ["kubectl", "get", "secret", secret_name, "-n", namespace,
         "-o", "jsonpath={.data}"],
        env={**os.environ, "KUBECONFIG": KUBECONFIG},
        capture_output=True, text=True,
    )

    if result.returncode != 0:
        log(f"  ⚠ Secret {namespace}/{secret_name} not found — nothing to back up")
        log(f"    stderr: {result.stderr.strip()}")
        return False

    try:
        secret_data = json.loads(result.stdout)
    except json.JSONDecodeError:
        log(f"  ⚠ Failed to parse Secret data: {result.stdout[:200]}")
        return False

    tls_crt = secret_data.get("tls.crt", "")
    tls_key = secret_data.get("tls.key", "")

    if not tls_crt or not tls_key:
        log("  ⚠ Secret exists but tls.crt or tls.key is empty — skipping backup")
        return False

    log(f"  ✓ Secret read ({len(tls_crt)} chars cert, {len(tls_key)} chars key)")

    # 2. Store in SSM as SecureString
    param_path = ssm_param_path(secret_name)
    payload = json.dumps({"tls.crt": tls_crt, "tls.key": tls_key})

    if dry_run:
        log(f"  [DRY-RUN] Would store at SSM: {param_path}")
        return True

    try:
        ssm = get_ssm_client()
        ssm.put_parameter(
            Name=param_path,
            Description=f"TLS cert+key backup for {namespace}/{secret_name}",
            Value=payload,
            Type="SecureString",
            Overwrite=True,
            Tier="Advanced",  # Advanced tier supports up to 8KB values
        )
        log(f"  ✓ Stored in SSM: {param_path}")
        return True
    except Exception as e:
        log(f"  ⚠ Failed to store in SSM: {e}")
        return False


# ---------------------------------------------------------------------------
# Restore: SSM → K8s Secret
# ---------------------------------------------------------------------------
def restore_cert(secret_name: str, namespace: str, dry_run: bool = False) -> bool:
    """Read TLS data from SSM and create the K8s Secret.

    If the Secret already exists in the cluster, it is left untouched
    (cert-manager will manage it from there).

    Args:
        secret_name: Name of the K8s Secret to restore.
        namespace: K8s namespace to create the Secret in.
        dry_run: If True, print actions without executing.

    Returns:
        True if restore succeeded or Secret already exists, False otherwise.
    """
    log(f"=== TLS Cert Restore: SSM → {namespace}/{secret_name} ===")

    # 1. Check if Secret already exists
    check = subprocess.run(
        ["kubectl", "get", "secret", secret_name, "-n", namespace],
        env={**os.environ, "KUBECONFIG": KUBECONFIG},
        capture_output=True, text=True,
    )

    if check.returncode == 0:
        log(f"  ✓ Secret {namespace}/{secret_name} already exists — skipping restore")
        return True

    # 2. Read from SSM
    param_path = ssm_param_path(secret_name)
    log(f"  → Reading from SSM: {param_path}")

    if dry_run:
        log(f"  [DRY-RUN] Would read SSM and create Secret")
        return True

    try:
        ssm = get_ssm_client()
        resp = ssm.get_parameter(Name=param_path, WithDecryption=True)
        payload = json.loads(resp["Parameter"]["Value"])
        tls_crt = payload["tls.crt"]
        tls_key = payload["tls.key"]
        log(f"  ✓ SSM parameter read ({len(tls_crt)} chars cert)")
    except ssm.exceptions.ParameterNotFound:
        log(f"  ⚠ SSM parameter {param_path} not found — no backup available")
        log("    cert-manager will request a new certificate")
        return False
    except Exception as e:
        log(f"  ⚠ Failed to read SSM: {e}")
        return False

    # 3. Ensure namespace exists
    subprocess.run(
        ["kubectl", "create", "namespace", namespace, "--dry-run=client", "-o", "yaml"],
        env={**os.environ, "KUBECONFIG": KUBECONFIG},
        capture_output=True, text=True,
    )

    # 4. Create the K8s TLS Secret
    #    Decode the base64 values so kubectl create secret tls can re-encode them
    try:
        cert_pem = base64.b64decode(tls_crt).decode()
        key_pem = base64.b64decode(tls_key).decode()
    except Exception as e:
        log(f"  ⚠ Failed to decode base64 cert data: {e}")
        return False

    # Write temp files for kubectl create secret tls
    cert_file = Path("/tmp/tls-restore-cert.pem")
    key_file = Path("/tmp/tls-restore-key.pem")

    try:
        cert_file.write_text(cert_pem)
        key_file.write_text(key_pem)

        result = subprocess.run(
            ["kubectl", "create", "secret", "tls", secret_name,
             "-n", namespace,
             f"--cert={cert_file}",
             f"--key={key_file}"],
            env={**os.environ, "KUBECONFIG": KUBECONFIG},
            capture_output=True, text=True,
        )

        if result.returncode == 0:
            log(f"  ✓ Secret {namespace}/{secret_name} restored from SSM")
            return True
        else:
            log(f"  ⚠ Failed to create Secret: {result.stderr.strip()}")
            return False
    finally:
        # Clean up temp files (contain private key)
        cert_file.unlink(missing_ok=True)
        key_file.unlink(missing_ok=True)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main() -> None:
    """Parse arguments and run backup or restore."""
    parser = argparse.ArgumentParser(
        description="Back up / restore TLS certificates via SSM Parameter Store"
    )
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--backup", action="store_true",
                       help="Back up K8s TLS Secret to SSM")
    group.add_argument("--restore", action="store_true",
                       help="Restore K8s TLS Secret from SSM")

    parser.add_argument("--secret", default="ops-tls-cert",
                        help="Name of the K8s Secret (default: ops-tls-cert)")
    parser.add_argument("--namespace", default="kube-system",
                        help="K8s namespace (default: kube-system)")
    parser.add_argument("--dry-run", action="store_true",
                        help="Print actions without executing")

    args = parser.parse_args()

    log(f"SSM prefix: {SSM_PREFIX}")
    log(f"Region:     {AWS_REGION}")
    log("")

    if args.backup:
        success = backup_cert(args.secret, args.namespace, args.dry_run)
    else:
        success = restore_cert(args.secret, args.namespace, args.dry_run)

    sys.exit(0 if success else 1)


if __name__ == "__main__":
    main()
