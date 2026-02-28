#!/usr/bin/env python3
"""
@format
Step 04 — Configure kubectl Access

Sets up kubeconfig for root, ec2-user, and ssm-user so that all users
can run kubectl commands. Also creates deferred ssm-user provisioning
for when the SSM agent creates the user on first session.

Idempotent: overwrites existing kubeconfig files.

Expected environment variables:
    None required — uses static paths.
"""

import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from common import StepRunner, run_cmd, log_info, log_warn

# =============================================================================
# Configuration
# =============================================================================

ADMIN_CONF = "/etc/kubernetes/admin.conf"

USERS = [
    {"name": "root", "home": "/root"},
    {"name": "ec2-user", "home": "/home/ec2-user"},
]

SSM_KUBECONFIG_SCRIPT = """\
#!/bin/bash
# One-shot: copy kubeconfig for ssm-user on first SSM session
if [ "$(whoami)" = "ssm-user" ] && [ ! -f "$HOME/.kube/config" ]; then
    mkdir -p "$HOME/.kube"
    sudo cp -f /etc/kubernetes/admin.conf "$HOME/.kube/config"
    sudo chown "$(id -u):$(id -g)" "$HOME/.kube/config"
    chmod 600 "$HOME/.kube/config"
fi
"""

BASHRC_KUBECONFIG = """
# --- Kubernetes kubeconfig (added by boot-k8s.sh) ---
export KUBECONFIG=/etc/kubernetes/admin.conf
"""


# =============================================================================
# Logic
# =============================================================================

def configure_user_kubeconfig(user: dict) -> None:
    """Copy admin.conf to user's .kube/config with correct ownership."""
    kube_dir = Path(user["home"]) / ".kube"
    kube_dir.mkdir(parents=True, exist_ok=True)
    config_path = kube_dir / "config"

    run_cmd(["cp", "-f", ADMIN_CONF, str(config_path)])

    if user["name"] != "root":
        run_cmd(["chown", f"{user['name']}:{user['name']}", str(config_path)])

    run_cmd(["chmod", "600", str(config_path)])
    log_info(f"  ✓ kubeconfig for {user['name']}")


def configure_ssm_user() -> None:
    """Set up kubeconfig for ssm-user (may not exist yet at boot time)."""
    result = run_cmd(["id", "ssm-user"], check=False)
    if result.returncode == 0:
        configure_user_kubeconfig({"name": "ssm-user", "home": "/home/ssm-user"})
    else:
        log_info("  ssm-user does not exist yet — deferred setup will run on first SSM session")

    # Write deferred provisioning script
    script_path = Path("/usr/local/bin/setup-ssm-kubeconfig.sh")
    script_path.write_text(SSM_KUBECONFIG_SCRIPT)
    run_cmd(["chmod", "755", str(script_path)])

    # Hook into bashrc (only once)
    bashrc = Path("/etc/bashrc")
    if bashrc.exists():
        content = bashrc.read_text()
        if "setup-ssm-kubeconfig" not in content:
            with bashrc.open("a") as f:
                f.write(
                    '[ -x /usr/local/bin/setup-ssm-kubeconfig.sh ] '
                    '&& /usr/local/bin/setup-ssm-kubeconfig.sh\n'
                )


def configure_global_kubeconfig() -> None:
    """Set KUBECONFIG for both login and non-login shells."""
    # Login shells: /etc/profile.d/
    profile_d = Path("/etc/profile.d/kubernetes.sh")
    profile_d.write_text(f"export KUBECONFIG={ADMIN_CONF}\n")
    run_cmd(["chmod", "644", str(profile_d)])

    # Non-login shells: /etc/bashrc (SSM Session Manager)
    bashrc = Path("/etc/bashrc")
    if bashrc.exists():
        content = bashrc.read_text()
        if "KUBECONFIG=" not in content:
            with bashrc.open("a") as f:
                f.write(BASHRC_KUBECONFIG)
    log_info("  ✓ Global KUBECONFIG configured (profile.d + bashrc)")


# =============================================================================
# Main
# =============================================================================

def main() -> None:
    with StepRunner("configure-kubectl") as step:
        if step.skipped:
            return

        log_info("Configuring kubectl access...")

        for user in USERS:
            configure_user_kubeconfig(user)

        configure_ssm_user()
        configure_global_kubeconfig()

        # Verify
        os.environ["KUBECONFIG"] = ADMIN_CONF
        run_cmd(["kubectl", "cluster-info"], check=False)
        run_cmd(["kubectl", "get", "namespaces"], check=False)

        log_info("kubectl access configured successfully")


if __name__ == "__main__":
    main()
