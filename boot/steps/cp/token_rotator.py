"""Step 11 — Install kubeadm token rotator systemd timer.

Creates a bash script that:
  1. Generates a new kubeadm join token (24h TTL)
  2. Validates the token format before writing to SSM
  3. Pushes the validated token to SSM SecureString

A systemd timer triggers this every 12 hours so workers can
always join the cluster with a valid token.
"""
from __future__ import annotations

from pathlib import Path

from common import (
    StepRunner,
    log_info,
    run_cmd,
)
from boot_helpers.config import BootConfig

# ── Constants ──────────────────────────────────────────────────────────────

TOKEN_ROTATOR_MARKER = "/etc/systemd/system/kubeadm-token-rotator.timer"

# Note: the doubled {{ }} are Python .format() escapes for literal braces
# in the grep regex. The \\. is a literal backslash-dot for bash grep.
TOKEN_ROTATOR_SCRIPT = """\
#!/bin/bash
set -euo pipefail

# Generate a new token valid for 24 hours
export KUBECONFIG=/etc/kubernetes/admin.conf
TOKEN=$(kubeadm token create --ttl 24h)

# Validate token format before writing to SSM — guards against corruption
if ! echo "$TOKEN" | grep -qE '^[a-z0-9]{{6}}\\.[a-z0-9]{{16}}$'; then
    echo "ERROR: kubeadm token create returned invalid token: $TOKEN" >&2
    exit 1
fi

# Push the validated token to SSM
aws ssm put-parameter \\
    --name "{SSM_PREFIX}/join-token" \\
    --value "$TOKEN" \\
    --type "SecureString" \\
    --overwrite \\
    --region "{AWS_REGION}"

echo "Successfully rotated and validated join token in SSM."
"""


def step_install_token_rotator(cfg: BootConfig) -> None:
    """Install a systemd timer to rotate the kubeadm join token.

    Generates a new token every 12 hours and pushes it to SSM,
    ensuring workers can always join the cluster with a valid,
    format-checked token.

    Args:
        cfg: Bootstrap configuration containing SSM prefix and AWS region.
    """
    with StepRunner("install-token-rotator", skip_if=TOKEN_ROTATOR_MARKER) as step:
        if step.skipped:
            return

        script_path = Path("/usr/local/bin/rotate-join-token.sh")
        script_content = TOKEN_ROTATOR_SCRIPT.format(
            SSM_PREFIX=cfg.ssm_prefix,
            AWS_REGION=cfg.aws_region,
        )
        script_path.write_text(script_content)
        run_cmd(["chmod", "755", str(script_path)])

        service_path = Path("/etc/systemd/system/kubeadm-token-rotator.service")
        service_path.write_text(
            "[Unit]\n"
            "Description=Rotate kubeadm join token and update SSM\n"
            "After=network-online.target\n\n"
            "[Service]\n"
            "Type=oneshot\n"
            "ExecStart=/usr/local/bin/rotate-join-token.sh\n"
        )

        timer_path = Path(TOKEN_ROTATOR_MARKER)
        timer_path.write_text(
            "[Unit]\n"
            "Description=Run kubeadm token rotator every 12 hours\n\n"
            "[Timer]\n"
            "OnBootSec=1h\n"
            "OnUnitActiveSec=12h\n"
            "RandomizedDelaySec=5m\n\n"
            "[Install]\n"
            "WantedBy=timers.target\n"
        )

        run_cmd(["systemctl", "daemon-reload"])
        run_cmd(["systemctl", "enable", "--now", "kubeadm-token-rotator.timer"])

        step.details["installed"] = True
        log_info("✓ kubeadm token rotator timer installed")
