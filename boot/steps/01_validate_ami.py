#!/usr/bin/env python3
"""
@format
Step 01 — Validate Golden AMI

Verifies that all required binaries and system settings are present on the
instance before proceeding with Kubernetes bootstrap.

Idempotent: always runs (validation is read-only).

Expected environment variables:
    None required — validates system state only.
"""

import shutil
import sys
from pathlib import Path

# Allow running as standalone script or as SSM RunCommand
sys.path.insert(0, str(Path(__file__).parent))
from common import StepRunner, log_info, log_error, run_cmd


# =============================================================================
# Constants
# =============================================================================

REQUIRED_BINARIES = ["containerd", "kubeadm", "kubelet", "kubectl", "helm"]

REQUIRED_KERNEL_MODULES = ["overlay", "br_netfilter"]

REQUIRED_SYSCTL = {
    "net.bridge.bridge-nf-call-iptables": "1",
    "net.bridge.bridge-nf-call-ip6tables": "1",
    "net.ipv4.ip_forward": "1",
}


# =============================================================================
# Validation Logic
# =============================================================================

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
        return REQUIRED_KERNEL_MODULES

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


# =============================================================================
# Main
# =============================================================================

def main() -> None:
    with StepRunner("validate-ami") as step:
        if step.skipped:
            return

        # 1. Binaries
        log_info("Checking required binaries...")
        missing_bins = validate_binaries()
        step.details["binaries_checked"] = REQUIRED_BINARIES
        step.details["binaries_missing"] = missing_bins

        # 2. Kernel modules
        log_info("Checking kernel modules...")
        missing_mods = validate_kernel_modules()
        step.details["modules_missing"] = missing_mods

        # 3. Sysctl
        log_info("Checking sysctl settings...")
        sysctl_errors = validate_sysctl()
        step.details["sysctl_errors"] = sysctl_errors

        # Verdict
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
                f"  Errors:\n" +
                "\n".join(f"    - {e}" for e in errors) +
                "\n\n  Resolution: Rebuild the Golden AMI with the missing components."
            )
            raise RuntimeError(msg)

        log_info("✓ Golden AMI validated — all required binaries and settings present")


if __name__ == "__main__":
    main()
