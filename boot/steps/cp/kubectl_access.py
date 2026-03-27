"""Step 5 — Configure kubectl access for root, ec2-user, and ssm-user."""
from __future__ import annotations

import os
from pathlib import Path

from common import (
    StepRunner,
    log_info,
    run_cmd,
)
from boot_helpers.config import BootConfig

# ── Constants ──────────────────────────────────────────────────────────────

ADMIN_CONF = "/etc/kubernetes/admin.conf"
KUBECONFIG_ENV = {"KUBECONFIG": ADMIN_CONF}

KUBECTL_USERS = [
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
# --- Kubernetes kubeconfig (added by bootstrap) ---
export KUBECONFIG=/etc/kubernetes/admin.conf
"""


# ── Step ───────────────────────────────────────────────────────────────────

def step_configure_kubectl(cfg: BootConfig) -> None:
    """Step 5: Set up kubectl access for root, ec2-user, and ssm-user.

    Args:
        cfg: Bootstrap configuration.
    """
    with StepRunner("configure-kubectl") as step:
        if step.skipped:
            return

        log_info("Configuring kubectl access...")

        for user in KUBECTL_USERS:
            kube_dir = Path(user["home"]) / ".kube"
            kube_dir.mkdir(parents=True, exist_ok=True)
            config_path = kube_dir / "config"
            run_cmd(["cp", "-f", ADMIN_CONF, str(config_path)])
            if user["name"] != "root":
                run_cmd(["chown", f"{user['name']}:{user['name']}", str(config_path)])
            run_cmd(["chmod", "600", str(config_path)])
            log_info(f"  ✓ kubeconfig for {user['name']}")

        # ssm-user
        result = run_cmd(["id", "ssm-user"], check=False)
        if result.returncode != 0:
            log_info("  ssm-user does not exist — creating it now")
            run_cmd(["useradd", "--system", "--shell", "/bin/bash",
                     "--create-home", "--home-dir", "/home/ssm-user",
                     "ssm-user"], check=False)

        ssm_kube_dir = Path("/home/ssm-user/.kube")
        ssm_kube_dir.mkdir(parents=True, exist_ok=True)
        ssm_config = ssm_kube_dir / "config"
        run_cmd(["cp", "-f", ADMIN_CONF, str(ssm_config)])
        run_cmd(["chown", "ssm-user:ssm-user", str(ssm_config)])
        run_cmd(["chmod", "600", str(ssm_config)])
        log_info("  ✓ kubeconfig for ssm-user")

        script_path = Path("/usr/local/bin/setup-ssm-kubeconfig.sh")
        script_path.write_text(SSM_KUBECONFIG_SCRIPT)
        run_cmd(["chmod", "755", str(script_path)])

        bashrc = Path("/etc/bashrc")
        if bashrc.exists():
            content = bashrc.read_text()
            if "setup-ssm-kubeconfig" not in content:
                with bashrc.open("a") as f:
                    f.write(
                        '[ -x /usr/local/bin/setup-ssm-kubeconfig.sh ] '
                        '&& /usr/local/bin/setup-ssm-kubeconfig.sh\n'
                    )

        # Global kubeconfig
        profile_d = Path("/etc/profile.d/kubernetes.sh")
        profile_d.write_text(f"export KUBECONFIG={ADMIN_CONF}\n")
        run_cmd(["chmod", "644", str(profile_d)])

        if bashrc.exists():
            content = bashrc.read_text()
            if "KUBECONFIG=" not in content:
                with bashrc.open("a") as f:
                    f.write(BASHRC_KUBECONFIG)
        log_info("  ✓ Global KUBECONFIG configured (profile.d + bashrc)")

        # Install Argo Rollouts CLI plugin
        argo_cli_path = Path("/usr/local/bin/kubectl-argo-rollouts")
        if not argo_cli_path.exists():
            log_info("Installing kubectl argo rollouts CLI plugin...")
            run_cmd([
                "curl", "-sLO",
                "https://github.com/argoproj/argo-rollouts/releases/latest/download/kubectl-argo-rollouts-linux-amd64"
            ])
            run_cmd(["mv", "kubectl-argo-rollouts-linux-amd64", str(argo_cli_path)])
            run_cmd(["chmod", "+x", str(argo_cli_path)])
            log_info("  ✓ kubectl argo rollouts installed")

        os.environ["KUBECONFIG"] = ADMIN_CONF
        run_cmd(["kubectl", "cluster-info"], check=False)
        run_cmd(["kubectl", "get", "namespaces"], check=False)
        log_info("kubectl access configured successfully")
