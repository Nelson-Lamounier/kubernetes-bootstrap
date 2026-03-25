#!/usr/bin/env python3
"""persist-tls-cert.py — Back up / restore K8s Secrets via SSM Parameter Store.

Prevents Let's Encrypt rate-limit exhaustion on instance replacement by
persisting cert-manager Secrets to SSM SecureString *after* issuance,
and restoring them *before* cert-manager starts on the next bootstrap.

Supports two Secret types:
  - kubernetes.io/tls  (e.g. ops-tls-cert: tls.crt + tls.key)
  - Opaque             (e.g. letsencrypt-account-key: tls.key only)

Modes:
  --backup   Read the K8s Secret → store in SSM (run after cert is Ready)
  --restore  Read SSM → create K8s Secret (run before cert-manager syncs)

SSM Parameter: {ssm_prefix}/tls/{secret_name}
  Stored as JSON: {"data": {"key": "base64value", ...}, "type": "kubernetes.io/tls"}

Usage:
  python3 persist-tls-cert.py --backup  --secret ops-tls-cert --namespace kube-system
  python3 persist-tls-cert.py --backup  --secret letsencrypt-account-key --namespace cert-manager
  python3 persist-tls-cert.py --restore --secret ops-tls-cert --namespace kube-system
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import TYPE_CHECKING, Any

from botocore.exceptions import ClientError

if TYPE_CHECKING:
    from mypy_boto3_ssm import SSMClient

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
SSM_PREFIX = os.environ.get("SSM_PREFIX", "/k8s/development")
AWS_REGION = os.environ.get("AWS_REGION", "eu-west-1")
KUBECONFIG = os.environ.get("KUBECONFIG", "/etc/kubernetes/admin.conf")


def log(msg: str) -> None:
    """Print a log message with immediate flush."""
    print(msg, flush=True)


def get_ssm_client() -> SSMClient:
    """Create a boto3 SSM client."""
    import boto3  # noqa: runtime-only import
    return boto3.client("ssm", region_name=AWS_REGION)  # type: ignore[return-value]


def ssm_param_path(secret_name: str) -> str:
    """Build the SSM parameter path for a TLS secret."""
    return f"{SSM_PREFIX}/tls/{secret_name}"


# ---------------------------------------------------------------------------
# Backup: K8s Secret → SSM
# ---------------------------------------------------------------------------
def backup_cert(secret_name: str, namespace: str, dry_run: bool = False) -> bool:
    """Read a K8s Secret (TLS or Opaque) and store its data in SSM.

    Stores both the data fields and the Secret type so the restore
    step can recreate the correct Secret kind.

    Args:
        secret_name: Name of the K8s Secret to back up.
        namespace: K8s namespace containing the Secret.
        dry_run: If True, print actions without executing.

    Returns:
        True if backup succeeded, False otherwise.
    """
    log(f"=== Secret Backup: {namespace}/{secret_name} → SSM ===")

    # 1. Read the K8s Secret (data + type)
    result = subprocess.run(
        ["kubectl", "get", "secret", secret_name, "-n", namespace,
         "-o", "jsonpath={.data},{.type}"],
        env={**os.environ, "KUBECONFIG": KUBECONFIG},
        capture_output=True, text=True,
    )

    if result.returncode != 0:
        log(f"  ⚠ Secret {namespace}/{secret_name} not found — nothing to back up")
        log(f"    stderr: {result.stderr.strip()}")
        return False

    # Parse the jsonpath output: "{data_json},{type_string}"
    raw_output = result.stdout.strip()
    # Split on last comma to separate data JSON from type string
    # The data JSON may contain commas, so find the last '},' boundary
    last_brace = raw_output.rfind("}")
    if last_brace == -1:
        log(f"  ⚠ Unexpected Secret format: {raw_output[:200]}")
        return False

    data_json = raw_output[:last_brace + 1]
    secret_type = raw_output[last_brace + 2:]  # Skip '},'

    try:
        secret_data = json.loads(data_json)
    except json.JSONDecodeError:
        log(f"  ⚠ Failed to parse Secret data: {data_json[:200]}")
        return False

    if not secret_data:
        log("  ⚠ Secret exists but has no data fields — skipping backup")
        return False

    field_summary = ", ".join(f"{k}={len(v)} chars" for k, v in secret_data.items())
    log(f"  ✓ Secret read (type={secret_type}, {field_summary})")

    # 2. Store in SSM as SecureString
    # Include the Secret type so restore knows whether to create TLS or Opaque
    param_path = ssm_param_path(secret_name)
    payload = json.dumps({"data": secret_data, "type": secret_type})

    if dry_run:
        log(f"  [DRY-RUN] Would store at SSM: {param_path}")
        return True

    try:
        ssm = get_ssm_client()
        ssm.put_parameter(
            Name=param_path,
            Description=f"Secret backup for {namespace}/{secret_name} (type={secret_type})",
            Value=payload,
            Type="SecureString",
            Overwrite=True,
            Tier="Advanced",  # Advanced tier supports up to 8KB values
        )
        log(f"  ✓ Stored in SSM: {param_path}")
        return True
    except ClientError as e:
        log(f"  ⚠ Failed to store in SSM: {e.response['Error']['Message']}")
        return False


# ---------------------------------------------------------------------------
# Restore: SSM → K8s Secret
# ---------------------------------------------------------------------------
def restore_cert(secret_name: str, namespace: str, dry_run: bool = False) -> bool:
    """Read Secret data from SSM and create the K8s Secret.

    Supports both kubernetes.io/tls Secrets (cert + key) and Opaque Secrets
    (e.g. ACME account key). The Secret type is auto-detected from the SSM
    backup payload.

    If the Secret already exists in the cluster, it is left untouched
    (cert-manager will manage it from there).

    Args:
        secret_name: Name of the K8s Secret to restore.
        namespace: K8s namespace to create the Secret in.
        dry_run: If True, print actions without executing.

    Returns:
        True if restore succeeded or Secret already exists, False otherwise.
    """
    log(f"=== Secret Restore: SSM → {namespace}/{secret_name} ===")

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
        log("  [DRY-RUN] Would read SSM and create Secret")
        return True

    try:
        ssm = get_ssm_client()
        resp = ssm.get_parameter(Name=param_path, WithDecryption=True)
        payload = json.loads(resp["Parameter"]["Value"])
    except ClientError as e:
        error_code = e.response["Error"]["Code"]
        if error_code == "ParameterNotFound":
            log(f"  ⚠ SSM parameter {param_path} not found — no backup available")
            log("    cert-manager will request a new certificate")
        else:
            log(f"  ⚠ Failed to read SSM: {e.response['Error']['Message']}")
        return False

    # Handle both old format ({"tls.crt": ..., "tls.key": ...}) and
    # new format ({"data": {...}, "type": "kubernetes.io/tls"})
    if "data" in payload and "type" in payload:
        secret_data = payload["data"]
        secret_type = payload["type"]
    else:
        # Legacy format — assume TLS
        secret_data = payload
        secret_type = "kubernetes.io/tls"

    log(f"  ✓ SSM parameter read (type={secret_type}, fields={list(secret_data.keys())})")

    # 3. Ensure namespace exists (create if missing, no-op if present)
    ns_yaml = subprocess.run(
        ["kubectl", "create", "namespace", namespace, "--dry-run=client", "-o", "yaml"],
        env={**os.environ, "KUBECONFIG": KUBECONFIG},
        capture_output=True, text=True,
    )
    if ns_yaml.returncode == 0:
        subprocess.run(
            ["kubectl", "apply", "-f", "-"],
            input=ns_yaml.stdout,
            env={**os.environ, "KUBECONFIG": KUBECONFIG},
            capture_output=True, text=True,
        )

    # 4. Create the K8s Secret
    if secret_type == "kubernetes.io/tls":
        return _restore_tls_secret(secret_name, namespace, secret_data)
    else:
        return _restore_opaque_secret(secret_name, namespace, secret_data)


def _restore_tls_secret(
    secret_name: str, namespace: str, secret_data: dict[str, str],
) -> bool:
    """Restore a kubernetes.io/tls Secret from decoded data."""
    tls_crt = secret_data.get("tls.crt", "")
    tls_key = secret_data.get("tls.key", "")

    if not tls_crt or not tls_key:
        log("  ⚠ Backup missing tls.crt or tls.key — cannot restore")
        return False

    try:
        cert_pem = base64.b64decode(tls_crt).decode()
        key_pem = base64.b64decode(tls_key).decode()
    except Exception as e:
        log(f"  ⚠ Failed to decode base64 cert data: {e}")
        return False

    return _create_tls_secret_from_pem(secret_name, namespace, cert_pem, key_pem)


def _create_tls_secret_from_pem(
    secret_name: str, namespace: str, cert_pem: str, key_pem: str,
) -> bool:
    """Write PEM data to temp files and create a TLS Secret via kubectl."""
    # Write temp files for kubectl create secret tls
    with tempfile.NamedTemporaryFile(
        mode="w", suffix=".pem", prefix="tls-cert-", delete=False,
    ) as cf, tempfile.NamedTemporaryFile(
        mode="w", suffix=".pem", prefix="tls-key-", delete=False,
    ) as kf:
        cert_path = Path(cf.name)
        key_path = Path(kf.name)
        cf.write(cert_pem)
        kf.write(key_pem)

    try:
        result = subprocess.run(
            ["kubectl", "create", "secret", "tls", secret_name,
             "-n", namespace,
             f"--cert={cert_path}",
             f"--key={key_path}"],
            env={**os.environ, "KUBECONFIG": KUBECONFIG},
            capture_output=True, text=True,
        )

        if result.returncode == 0:
            log(f"  ✓ TLS Secret {namespace}/{secret_name} restored from SSM")
            return True
        else:
            log(f"  ⚠ Failed to create TLS Secret: {result.stderr.strip()}")
            return False
    finally:
        cert_path.unlink(missing_ok=True)
        key_path.unlink(missing_ok=True)


def _restore_opaque_secret(
    secret_name: str, namespace: str, secret_data: dict[str, str],
) -> bool:
    """Restore an Opaque Secret (e.g. ACME account key) from backed-up data."""
    # Build kubectl create secret generic command with --from-literal for each field
    cmd = [
        "kubectl", "create", "secret", "generic", secret_name,
        "-n", namespace,
    ]

    # Each field is base64-encoded in the backup; decode and pass as literal
    temp_files: list[Path] = []
    try:
        for key, b64_value in secret_data.items():
            decoded: bytes = base64.b64decode(b64_value)
            # Write to a temp file (values may contain binary data)
            tmp_fd = tempfile.NamedTemporaryFile(
                prefix=f"secret-{key.replace('.', '-')}-", delete=False,
            )
            tmp = Path(tmp_fd.name)
            tmp_fd.write(decoded)
            tmp_fd.close()
            temp_files.append(tmp)
            cmd.append(f"--from-file={key}={tmp}")

        result = subprocess.run(
            cmd,
            env={**os.environ, "KUBECONFIG": KUBECONFIG},
            capture_output=True, text=True,
        )

        if result.returncode == 0:
            log(f"  ✓ Opaque Secret {namespace}/{secret_name} restored from SSM")
            return True
        else:
            log(f"  ⚠ Failed to create Opaque Secret: {result.stderr.strip()}")
            return False
    except Exception as e:
        log(f"  ⚠ Failed to decode secret data: {e}")
        return False
    finally:
        for tmp in temp_files:
            tmp.unlink(missing_ok=True)


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
