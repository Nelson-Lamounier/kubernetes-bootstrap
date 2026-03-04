#!/usr/bin/env python3
"""
@format
Step 08 — Install and Configure CloudWatch Agent

Installs the Amazon CloudWatch Agent on the EC2 instance and configures it
to stream system logs to the CloudWatch log group created by CDK
(via LaunchTemplateConstruct).

The log group name is resolved from the environment variable LOG_GROUP_NAME,
which is persisted in /etc/profile.d/k8s-env.sh by user data at boot time.

Collected log files:
  - /var/log/messages         — system syslog
  - /var/log/user-data.log    — user data script output
  - /var/log/cloud-init-output.log — cloud-init output

Prerequisites:
  - IAM: CloudWatchAgentServerPolicy (attached by LaunchTemplateConstruct)
  - Log group: /ec2/{namePrefix}/instances (created by LaunchTemplateConstruct)
  - ENV: LOG_GROUP_NAME in /etc/profile.d/k8s-env.sh

Idempotent: skips if agent is already running with correct config.
"""

import json
import os
import sys
from pathlib import Path

# Add parent directory to path for common module import
sys.path.insert(0, str(Path(__file__).parent))
from common import StepRunner, run_cmd, log_info, log_warn, log_error

# =============================================================================
# Constants
# =============================================================================

MARKER_FILE = "/tmp/.cw-agent-installed"
AGENT_CTL = "/opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl"
AGENT_CONFIG_PATH = "/opt/aws/amazon-cloudwatch-agent/etc/amazon-cloudwatch-agent.json"

# Source the k8s-env.sh file to get LOG_GROUP_NAME if not already in env
K8S_ENV_FILE = "/etc/profile.d/k8s-env.sh"

# Log files to collect
LOG_FILES = [
    {
        "file_path": "/var/log/messages",
        "log_stream_name": "{instance_id}/messages",
    },
    {
        "file_path": "/var/log/user-data.log",
        "log_stream_name": "{instance_id}/user-data",
    },
    {
        "file_path": "/var/log/cloud-init-output.log",
        "log_stream_name": "{instance_id}/cloud-init",
    },
]


# =============================================================================
# Helpers
# =============================================================================

def resolve_log_group_name() -> str:
    """
    Resolve the CloudWatch log group name from environment or k8s-env.sh.

    Priority:
      1. LOG_GROUP_NAME environment variable (set by SSM Automation)
      2. Parsed from /etc/profile.d/k8s-env.sh (set by user data)
    """
    # Check direct environment
    log_group = os.environ.get("LOG_GROUP_NAME", "")
    if log_group:
        return log_group

    # Parse from k8s-env.sh
    env_file = Path(K8S_ENV_FILE)
    if env_file.exists():
        for line in env_file.read_text().splitlines():
            line = line.strip()
            if line.startswith("export LOG_GROUP_NAME="):
                # Handle both quoted and unquoted values
                value = line.split("=", 1)[1].strip().strip('"').strip("'")
                if value:
                    return value

    return ""


def build_agent_config(log_group_name: str) -> dict:
    """Build the CloudWatch Agent configuration JSON."""
    collect_list = []
    for lf in LOG_FILES:
        collect_list.append({
            "file_path": lf["file_path"],
            "log_group_name": log_group_name,
            "log_stream_name": lf["log_stream_name"],
            "retention_in_days": 30,
        })

    return {
        "agent": {
            "metrics_collection_interval": 60,
            "logfile": "/opt/aws/amazon-cloudwatch-agent/logs/amazon-cloudwatch-agent.log",
        },
        "logs": {
            "logs_collected": {
                "files": {
                    "collect_list": collect_list,
                },
            },
        },
    }


def is_agent_running() -> bool:
    """Check if the CloudWatch Agent is already running."""
    result = run_cmd([AGENT_CTL, "-a", "status"], check=False)
    return result.returncode == 0 and "running" in result.stdout.lower()


# =============================================================================
# Main
# =============================================================================

def main():
    with StepRunner("install-cloudwatch-agent", skip_if=MARKER_FILE) as step:
        if step.skipped:
            return

        # Resolve log group name
        log_group_name = resolve_log_group_name()
        if not log_group_name:
            log_warn(
                "LOG_GROUP_NAME not found in environment or k8s-env.sh — "
                "skipping CloudWatch Agent installation"
            )
            step.details["skipped_reason"] = "LOG_GROUP_NAME not set"
            return

        log_info(f"Target log group: {log_group_name}")
        step.details["log_group_name"] = log_group_name

        # Install agent (idempotent — dnf/yum skips if already installed)
        log_info("Installing amazon-cloudwatch-agent...")
        result = run_cmd(
            "dnf install -y amazon-cloudwatch-agent 2>/dev/null || "
            "yum install -y amazon-cloudwatch-agent",
            shell=True,
            check=True,
            timeout=120,
        )
        step.details["install_exit_code"] = result.returncode

        # Write agent config
        config = build_agent_config(log_group_name)
        config_path = Path(AGENT_CONFIG_PATH)
        config_path.parent.mkdir(parents=True, exist_ok=True)
        config_path.write_text(json.dumps(config, indent=2))
        log_info(f"Agent config written to {AGENT_CONFIG_PATH}")
        step.details["log_files"] = [lf["file_path"] for lf in LOG_FILES]

        # Start/restart the agent
        log_info("Starting CloudWatch Agent...")
        run_cmd([
            AGENT_CTL,
            "-a", "fetch-config",
            "-m", "ec2",
            "-c", f"file:{AGENT_CONFIG_PATH}",
            "-s",
        ], timeout=60)

        # Verify agent is running
        if is_agent_running():
            log_info("CloudWatch Agent is running")
            step.details["agent_status"] = "running"
        else:
            log_warn("CloudWatch Agent may not be running — check agent logs")
            step.details["agent_status"] = "unknown"


if __name__ == "__main__":
    main()
