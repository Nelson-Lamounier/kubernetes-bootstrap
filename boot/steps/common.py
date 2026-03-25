#!/usr/bin/env python3
"""
@format
Common utilities for K8s bootstrap step scripts.

Provides structured logging, subprocess execution, SSM helpers,
idempotency guards, and shared bootstrap steps used by all step scripts.

Shared Steps:
    - step_validate_ami: Validate Golden AMI binaries and kernel settings
    - step_install_cloudwatch_agent: Install and configure CloudWatch Agent

Usage from a step script:
    from common import (
        StepRunner, run_cmd, ssm_get, ssm_put, log_info,
        step_validate_ami, step_install_cloudwatch_agent,
    )
"""

import json
import os
import shutil
import subprocess
import time
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional, Union

# =============================================================================
# Configuration
# =============================================================================

STATUS_FILE = Path("/tmp/bootstrap-status.json")
SSM_PREFIX = os.environ.get("SSM_PREFIX", "/k8s/development")
AWS_REGION = os.environ.get("AWS_REGION", "eu-west-1")


# =============================================================================
# Structured Logging
# =============================================================================

def log(level: str, message: str, **kwargs) -> None:
    """Emit a structured log line to stdout."""
    entry = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "level": level,
        "message": message,
        **kwargs,
    }
    print(json.dumps(entry), flush=True)


def log_info(message: str, **kwargs) -> None:
    log("INFO", message, **kwargs)


def log_warn(message: str, **kwargs) -> None:
    log("WARN", message, **kwargs)


def log_error(message: str, **kwargs) -> None:
    log("ERROR", message, **kwargs)


# =============================================================================
# Command Execution
# =============================================================================

@dataclass
class CmdResult:
    """Result of a subprocess execution."""
    returncode: int
    stdout: str
    stderr: str
    command: str
    duration_seconds: float


def run_cmd(
    cmd: Union[list[str], str],
    *,
    shell: bool = False,
    check: bool = True,
    timeout: int = 300,
    env: Optional[dict] = None,
    capture: bool = True,
) -> CmdResult:
    """
    Execute a command with structured logging and timing.

    Args:
        cmd: Command as list of args or string (if shell=True).
        shell: Run through shell interpreter.
        check: Raise on non-zero exit code.
        timeout: Seconds before killing the process.
        env: Additional environment variables (merged with os.environ).
        capture: Capture stdout/stderr (False to stream live).

    Returns:
        CmdResult with exit code, output, and timing.

    Raises:
        subprocess.CalledProcessError: If check=True and command fails.
    """
    cmd_str = cmd if isinstance(cmd, str) else " ".join(cmd)
    log_info(f"Running: {cmd_str}")

    merged_env = {**os.environ, **(env or {})}
    start = time.monotonic()

    try:
        result = subprocess.run(
            cmd,
            shell=shell,
            capture_output=capture,
            text=True,
            timeout=timeout,
            env=merged_env,
        )
    except subprocess.TimeoutExpired:
        duration = time.monotonic() - start
        log_error(f"Command timed out after {timeout}s", command=cmd_str)
        raise

    duration = time.monotonic() - start

    cmd_result = CmdResult(
        returncode=result.returncode,
        stdout=result.stdout if capture else "",
        stderr=result.stderr if capture else "",
        command=cmd_str,
        duration_seconds=round(duration, 2),
    )

    if result.returncode != 0:
        log_error(
            f"Command failed (exit {result.returncode})",
            command=cmd_str,
            duration=cmd_result.duration_seconds,
            stderr=cmd_result.stderr[:500] if capture else "",
        )
        if check:
            raise subprocess.CalledProcessError(
                result.returncode, cmd,
                output=result.stdout, stderr=result.stderr,
            )
    else:
        log_info(
            "Command succeeded",
            command=cmd_str,
            duration=cmd_result.duration_seconds,
        )

    return cmd_result


# =============================================================================
# SSM Parameter Store Helpers
# =============================================================================

def ssm_get(name: str, *, decrypt: bool = False) -> Optional[str]:
    """
    Get an SSM parameter value. Returns None if not found.

    Args:
        name: Full parameter name (e.g. /k8s/development/join-token).
        decrypt: Use --with-decryption for SecureString parameters.
    """
    cmd = [
        "aws", "ssm", "get-parameter",
        "--name", name,
        "--query", "Parameter.Value",
        "--output", "text",
        "--region", AWS_REGION,
    ]
    if decrypt:
        cmd.append("--with-decryption")

    try:
        result = run_cmd(cmd, check=False)
        if result.returncode == 0 and result.stdout.strip() not in ("None", ""):
            return result.stdout.strip()
    except Exception:
        pass
    return None


def ssm_put(
    name: str,
    value: str,
    *,
    param_type: str = "String",
    tier: Optional[str] = None,
) -> None:
    """
    Write an SSM parameter (creates or overwrites).

    Args:
        name: Full parameter name.
        value: Parameter value.
        param_type: SSM parameter type (String, SecureString, StringList).
        tier: SSM parameter tier (Standard, Advanced, Intelligent-Tiering).
              Standard supports up to 4KB, Advanced up to 8KB.
              Omit to use the AWS default (Standard).
    """
    cmd = [
        "aws", "ssm", "put-parameter",
        "--name", name,
        "--value", value,
        "--type", param_type,
        "--overwrite",
        "--region", AWS_REGION,
    ]
    if tier:
        cmd.extend(["--tier", tier])
    run_cmd(cmd)


# =============================================================================
# Idempotency Guards
# =============================================================================

def is_already_done(marker_file: str) -> bool:
    """Check if a step has already completed (marker file exists)."""
    return Path(marker_file).exists()


def mark_done(marker_file: str) -> None:
    """Create a marker file indicating step completion."""
    Path(marker_file).touch()


# =============================================================================
# Step Status Reporting
# =============================================================================

@dataclass
class StepStatus:
    """Status of a single bootstrap step."""
    step_name: str
    status: str  # "running", "success", "failed", "skipped"
    started_at: str = ""
    completed_at: str = ""
    duration_seconds: float = 0.0
    error: str = ""
    details: dict = field(default_factory=dict)


def write_status(statuses: list[StepStatus]) -> None:
    """Write step statuses to the status file (JSON)."""
    data = {
        "updated_at": datetime.now(timezone.utc).isoformat(),
        "steps": [asdict(s) for s in statuses],
    }
    STATUS_FILE.write_text(json.dumps(data, indent=2))


# =============================================================================
# Step Runner
# =============================================================================

class StepRunner:
    """
    Context manager for running a bootstrap step with timing and status reporting.

    Usage:
        with StepRunner("validate-ami") as step:
            # ... step logic ...
            step.details["binaries_found"] = ["kubeadm", "kubelet"]

        # On success: step.status = "success"
        # On exception: step.status = "failed", step.error = str(exception)
    """

    def __init__(self, step_name: str, *, skip_if: Optional[str] = None):
        """
        Args:
            step_name: Human-readable step name for logging.
            skip_if: Path to marker file — if it exists, step is skipped.
        """
        self.step_name = step_name
        self.skip_if = skip_if
        self._status = StepStatus(step_name=step_name, status="running")
        self._start_time = 0.0
        self.details: dict = {}

    def __enter__(self):
        # Check idempotency guard
        if self.skip_if and is_already_done(self.skip_if):
            log_info(f"Step '{self.step_name}' already completed — skipping",
                     marker=self.skip_if)
            self._status.status = "skipped"
            return self

        log_info(f"=== Starting step: {self.step_name} ===")
        self._status.started_at = datetime.now(timezone.utc).isoformat()
        self._start_time = time.monotonic()
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        if self._status.status == "skipped":
            return False  # Don't suppress exceptions (none expected)

        duration = time.monotonic() - self._start_time
        self._status.duration_seconds = round(duration, 2)
        self._status.completed_at = datetime.now(timezone.utc).isoformat()
        self._status.details = self.details

        if exc_type is not None:
            self._status.status = "failed"
            self._status.error = str(exc_val)
            log_error(
                f"Step '{self.step_name}' FAILED in {duration:.1f}s",
                error=str(exc_val),
            )
            return False  # Propagate exception

        self._status.status = "success"
        log_info(f"Step '{self.step_name}' completed in {duration:.1f}s")

        # Mark done if idempotency marker is configured
        if self.skip_if:
            mark_done(self.skip_if)

        return False

    @property
    def skipped(self) -> bool:
        return self._status.status == "skipped"

    @property
    def status(self) -> StepStatus:
        return self._status


# =============================================================================
# IMDS v2 Helper
# =============================================================================

def get_imds_value(path: str) -> str:
    """Fetch a value from EC2 Instance Metadata Service v2."""
    token = run_cmd(
        ["curl", "-sX", "PUT", "http://169.254.169.254/latest/api/token",
         "-H", "X-aws-ec2-metadata-token-ttl-seconds: 21600"],
        check=True,
    ).stdout.strip()

    result = run_cmd(
        ["curl", "-s", "-H", f"X-aws-ec2-metadata-token: {token}",
         f"http://169.254.169.254/latest/meta-data/{path}"],
        check=False,
    )
    return result.stdout.strip() if result.returncode == 0 else ""


def patch_provider_id(kubeconfig: str = "/etc/kubernetes/kubelet.conf") -> None:
    """Patch the node's spec.providerID so the AWS Cloud Controller Manager
    can map this Kubernetes node to its underlying EC2 instance.

    Without providerID, the CCM cannot detect terminated instances and
    will not auto-delete dead nodes from the cluster.

    Must be called after ``kubeadm join`` / ``kubeadm init`` completes
    and the kubelet has registered the node with the API server.

    Args:
        kubeconfig: Path to kubeconfig with permissions to patch nodes.
    """
    instance_id = get_imds_value("instance-id")
    az = get_imds_value("placement/availability-zone")
    hostname = get_imds_value("hostname")

    if not instance_id or not az:
        log_warn(
            "Could not retrieve instance-id or AZ from IMDS — "
            "providerID will not be set. The AWS CCM should set it "
            "when it initialises this node."
        )
        return

    provider_id = f"aws:///{az}/{instance_id}"
    log_info(f"Setting providerID: {provider_id}")

    # Use the node's hostname (FQDN) as the node name in kubectl.
    # kubeadm registers the node with this name by default.
    if not hostname:
        log_warn("Could not determine hostname from IMDS — skipping providerID patch")
        return

    patch_payload = json.dumps({"spec": {"providerID": provider_id}})
    result = run_cmd(
        [
            "kubectl", "--kubeconfig", kubeconfig,
            "patch", "node", hostname,
            "--type", "merge",
            "-p", patch_payload,
        ],
        check=False,
        env={"KUBECONFIG": kubeconfig},
    )

    if result.returncode == 0:
        log_info(f"providerID set on node {hostname}: {provider_id}")
    else:
        log_warn(
            f"Failed to patch providerID on {hostname} (exit {result.returncode}). "
            f"The AWS CCM will set it during node initialisation."
        )


# =============================================================================
# ECR Credential Provider
# =============================================================================

ECR_PROVIDER_BIN = "/usr/local/bin/ecr-credential-provider"
ECR_PROVIDER_CONFIG = "/etc/kubernetes/image-credential-provider-config.yaml"
# Pin to v1.31.0 — the last version with published raw binaries on GCS.
# The cloud-provider-aws maintainers stopped publishing standalone binaries
# after v1.31.0 (only container images for newer versions).
# The credential provider plugin API (credentialprovider.kubelet.k8s.io/v1)
# is stable and version-independent, so v1.31.0 works on v1.35.x clusters.
ECR_PROVIDER_VERSION = "v1.31.0"

# Official release URL for the ecr-credential-provider binary
# Hosted on Google Cloud Storage under the k8s-artifacts-prod bucket.
# NOTE: The old k8s-staging-provider-aws bucket was retired.
_ECR_PROVIDER_RELEASE_URL = (
    "https://storage.googleapis.com/k8s-artifacts-prod/binaries/cloud-provider-aws"
    f"/{ECR_PROVIDER_VERSION}/linux/{{arch}}/ecr-credential-provider-linux-{{arch}}"
)

_ECR_PROVIDER_CONFIG_CONTENT = """\
apiVersion: kubelet.config.k8s.io/v1
kind: CredentialProviderConfig
providers:
  - name: ecr-credential-provider
    matchImages:
      - "*.dkr.ecr.*.amazonaws.com"
    defaultCacheDuration: "12h"
    apiVersion: credentialprovider.kubelet.k8s.io/v1
"""


def _install_ecr_provider_from_image() -> bool:
    """
    Download the ecr-credential-provider binary from the official Kubernetes
    cloud-provider-aws release artifacts.

    NOTE: Previous versions tried to extract the binary from the
    cloud-controller-manager container image, but that image does NOT
    contain ecr-credential-provider — it's a separate binary published
    as a standalone release artifact.

    Returns True on success, False on failure.
    """
    try:
        # Detect architecture
        result = run_cmd(["uname", "-m"], check=False)
        uname_out = result.stdout.strip() if result and result.stdout else "x86_64"
        arch = "arm64" if uname_out == "aarch64" else "amd64"

        download_url = _ECR_PROVIDER_RELEASE_URL.format(arch=arch)
        log_info(f"Downloading ecr-credential-provider {ECR_PROVIDER_VERSION} ({arch})...")
        log_info(f"  URL: {download_url}")

        # Download the binary directly
        run_cmd(
            ["curl", "-fsSL", "-o", ECR_PROVIDER_BIN, download_url],
            timeout=60,
        )

        if Path(ECR_PROVIDER_BIN).exists():
            run_cmd(["chmod", "+x", ECR_PROVIDER_BIN])
            log_info(f"ECR credential provider installed: {ECR_PROVIDER_BIN}")
            return True

    except Exception as e:
        log_warn(f"Binary download failed: {e}")

    return False


def _install_ecr_provider_via_go() -> bool:
    """
    Build ecr-credential-provider from source using go install.
    Fallback if container image extraction fails.

    Returns True on success, False on failure.
    """
    try:
        # Check if Go is available
        result = run_cmd(["go", "version"], check=False)
        if result.returncode != 0:
            log_warn("Go not available — cannot build from source")
            return False

        log_info(f"Building ecr-credential-provider {ECR_PROVIDER_VERSION} from source...")
        run_cmd(
            ["go", "install",
             f"k8s.io/cloud-provider-aws/cmd/ecr-credential-provider@{ECR_PROVIDER_VERSION}"],
            timeout=120,
            env={"GOBIN": "/usr/local/bin"},
        )

        if Path(ECR_PROVIDER_BIN).exists():
            run_cmd(["chmod", "+x", ECR_PROVIDER_BIN])
            return True

    except Exception as e:
        log_warn(f"Go build failed: {e}")

    return False


def ensure_ecr_credential_provider() -> None:
    """
    Ensure the ECR credential provider binary and config are installed.

    Idempotent: skips if binary already exists and is executable.
    Uses multiple strategies:
    1. Skip if already installed (pre-baked in Golden AMI or previous run)
    2. Extract from official container image via containerd (ctr)
    3. Build from source via go install (fallback)
    """
    # Install binary if missing
    bin_path = Path(ECR_PROVIDER_BIN)
    if bin_path.exists() and os.access(str(bin_path), os.X_OK):
        log_info(f"ECR credential provider already installed at {ECR_PROVIDER_BIN}")
    else:
        log_info(f"Installing ECR credential provider {ECR_PROVIDER_VERSION}...")

        installed = _install_ecr_provider_from_image()

        if not installed:
            log_warn("Container image extraction failed, trying go install...")
            installed = _install_ecr_provider_via_go()

        if not installed:
            raise RuntimeError(
                f"Failed to install ecr-credential-provider {ECR_PROVIDER_VERSION}. "
                f"Tried: container image extraction, go install. "
                f"Ensure the Golden AMI includes the binary at {ECR_PROVIDER_BIN}, "
                f"or that containerd/go is available on the node."
            )

        log_info(f"ECR credential provider {ECR_PROVIDER_VERSION} installed successfully")

    # Create config if missing
    config_path = Path(ECR_PROVIDER_CONFIG)
    if config_path.exists():
        log_info(f"ECR credential provider config already exists at {ECR_PROVIDER_CONFIG}")
    else:
        config_path.parent.mkdir(parents=True, exist_ok=True)
        config_path.write_text(_ECR_PROVIDER_CONFIG_CONTENT)
        log_info(f"ECR credential provider config created at {ECR_PROVIDER_CONFIG}")


# =============================================================================
# Shared Step — Validate Golden AMI
#
# Used by both control_plane.py and worker.py.  Verifies that the
# Golden AMI includes all required binaries, kernel modules, and
# sysctl settings.  These are prerequisites baked into the AMI —
# the bootstrap scripts do NOT install packages at boot time.
# =============================================================================

REQUIRED_BINARIES = ["containerd", "kubeadm", "kubelet", "kubectl", "helm"]
REQUIRED_KERNEL_MODULES = ["overlay", "br_netfilter"]
REQUIRED_SYSCTL = {
    "net.bridge.bridge-nf-call-iptables": "1",
    "net.bridge.bridge-nf-call-ip6tables": "1",
    "net.ipv4.ip_forward": "1",
}


def validate_binaries() -> list[str]:
    """Check that all required binaries are on $PATH. Returns missing list."""
    missing = []
    found = []
    for binary in REQUIRED_BINARIES:
        path = shutil.which(binary)
        if path:
            found.append(f"{binary} -> {path}")
        else:
            missing.append(binary)
    for f in found:
        log_info(f"  ✓ {f}")
    return missing


def validate_kernel_modules() -> list[str]:
    """Check kernel modules are loaded. Returns missing list."""
    missing = []
    try:
        loaded = Path("/proc/modules").read_text()
    except FileNotFoundError:
        log_error("/proc/modules not found — cannot validate kernel modules")
        return list(REQUIRED_KERNEL_MODULES)

    for mod in REQUIRED_KERNEL_MODULES:
        if mod in loaded:
            log_info(f"  ✓ Kernel module: {mod}")
        else:
            missing.append(mod)
    return missing


def validate_sysctl() -> list[str]:
    """Check sysctl settings. Returns misconfigured list."""
    errors = []
    for key, expected in REQUIRED_SYSCTL.items():
        sysctl_path = Path(f"/proc/sys/{key.replace('.', '/')}")
        try:
            actual = sysctl_path.read_text().strip()
            if actual == expected:
                log_info(f"  ✓ sysctl {key} = {actual}")
            else:
                errors.append(f"{key}: expected={expected}, actual={actual}")
        except FileNotFoundError:
            errors.append(f"{key}: not found at {sysctl_path}")
    return errors


def step_validate_ami() -> None:
    """Validate Golden AMI binaries and kernel settings.

    Shared by control plane and worker bootstrap scripts.
    Raises RuntimeError if any required binary, kernel module,
    or sysctl setting is missing or misconfigured.
    """
    with StepRunner("validate-ami") as step:
        if step.skipped:
            return

        log_info("Checking required binaries...")
        missing_bins = validate_binaries()
        step.details["binaries_checked"] = REQUIRED_BINARIES
        step.details["binaries_missing"] = missing_bins

        log_info("Checking kernel modules...")
        missing_mods = validate_kernel_modules()
        step.details["modules_missing"] = missing_mods

        log_info("Checking sysctl settings...")
        sysctl_errors = validate_sysctl()
        step.details["sysctl_errors"] = sysctl_errors

        errors = []
        if missing_bins:
            errors.append(f"Missing binaries: {', '.join(missing_bins)}")
        if missing_mods:
            errors.append(f"Missing kernel modules: {', '.join(missing_mods)}")
        if sysctl_errors:
            errors.append(f"Sysctl errors: {'; '.join(sysctl_errors)}")

        if errors:
            msg = (
                "Golden AMI validation FAILED.\n"
                "  The bootstrap script does NOT install packages at boot time.\n"
                "  All binaries must be pre-baked into the Golden AMI.\n\n"
                "  Errors:\n" +
                "\n".join(f"    - {e}" for e in errors) +
                "\n\n  Resolution: Rebuild the Golden AMI with the missing components."
            )
            raise RuntimeError(msg)

        log_info("✓ Golden AMI validated — all required binaries and settings present")


# =============================================================================
# Shared Step — Install CloudWatch Agent
#
# Used by both control_plane.py and worker.py.  Installs the
# CloudWatch Agent and configures it to stream system log files
# to a CloudWatch log group.
# =============================================================================

CW_MARKER_FILE = "/tmp/.cw-agent-installed"
CW_AGENT_CTL = "/opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl"
CW_AGENT_CONFIG_PATH = "/opt/aws/amazon-cloudwatch-agent/etc/amazon-cloudwatch-agent.json"
K8S_ENV_FILE = "/etc/profile.d/k8s-env.sh"

CW_LOG_FILES = [
    {"file_path": "/var/log/messages", "log_stream_name": "{instance_id}/messages"},
    {"file_path": "/var/log/user-data.log", "log_stream_name": "{instance_id}/user-data"},
    {"file_path": "/var/log/cloud-init-output.log", "log_stream_name": "{instance_id}/cloud-init"},
]


def _resolve_log_group_name() -> str:
    """Resolve the CloudWatch log group name from environment or k8s-env.sh."""
    log_group = os.environ.get("LOG_GROUP_NAME", "")
    if log_group:
        return log_group

    env_file = Path(K8S_ENV_FILE)
    if env_file.exists():
        for line in env_file.read_text().splitlines():
            line = line.strip()
            if line.startswith("export LOG_GROUP_NAME="):
                value = line.split("=", 1)[1].strip().strip('"').strip("'")
                if value:
                    return value
    return ""


def step_install_cloudwatch_agent() -> None:
    """Install and configure CloudWatch Agent for log streaming.

    Shared by control plane and worker bootstrap scripts.
    Idempotent: skips if marker file ``/tmp/.cw-agent-installed`` exists.
    """
    with StepRunner("install-cloudwatch-agent", skip_if=CW_MARKER_FILE) as step:
        if step.skipped:
            return

        log_group_name = _resolve_log_group_name()
        if not log_group_name:
            log_warn(
                "LOG_GROUP_NAME not found in environment or k8s-env.sh — "
                "skipping CloudWatch Agent installation"
            )
            step.details["skipped_reason"] = "LOG_GROUP_NAME not set"
            return

        log_info(f"Target log group: {log_group_name}")
        step.details["log_group_name"] = log_group_name

        log_info("Installing amazon-cloudwatch-agent...")
        result = run_cmd(
            "dnf install -y amazon-cloudwatch-agent 2>/dev/null || "
            "yum install -y amazon-cloudwatch-agent",
            shell=True, check=True, timeout=120,
        )
        step.details["install_exit_code"] = result.returncode

        collect_list = []
        for lf in CW_LOG_FILES:
            collect_list.append({
                "file_path": lf["file_path"],
                "log_group_name": log_group_name,
                "log_stream_name": lf["log_stream_name"],
                "retention_in_days": 30,
            })

        config = {
            "agent": {
                "metrics_collection_interval": 60,
                "logfile": "/opt/aws/amazon-cloudwatch-agent/logs/amazon-cloudwatch-agent.log",
            },
            "logs": {
                "logs_collected": {
                    "files": {"collect_list": collect_list},
                },
            },
        }

        config_path = Path(CW_AGENT_CONFIG_PATH)
        config_path.parent.mkdir(parents=True, exist_ok=True)
        config_path.write_text(json.dumps(config, indent=2))
        log_info(f"Agent config written to {CW_AGENT_CONFIG_PATH}")
        step.details["log_files"] = [lf["file_path"] for lf in CW_LOG_FILES]

        log_info("Starting CloudWatch Agent...")
        run_cmd([
            CW_AGENT_CTL,
            "-a", "fetch-config",
            "-m", "ec2",
            "-c", f"file:{CW_AGENT_CONFIG_PATH}",
            "-s",
        ], timeout=60)

        result = run_cmd([CW_AGENT_CTL, "-a", "status"], check=False)
        if result.returncode == 0 and "running" in result.stdout.lower():
            log_info("CloudWatch Agent is running")
            step.details["agent_status"] = "running"
        else:
            log_warn("CloudWatch Agent may not be running — check agent logs")
            step.details["agent_status"] = "unknown"


