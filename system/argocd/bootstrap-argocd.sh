#!/usr/bin/env bash
# bootstrap-argocd.sh — Thin wrapper for Python bootstrap script.
#
# Preserves compatibility with callers expecting a .sh entrypoint.
# Installs Python dependencies and delegates to bootstrap_argocd.py.
#
# Usage:
#   KUBECONFIG=/etc/kubernetes/admin.conf bash bootstrap-argocd.sh
#   KUBECONFIG=/etc/kubernetes/admin.conf bash bootstrap-argocd.sh --dry-run

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Ensure pip3 is available — Amazon Linux 2023 does NOT pre-install it.
# python3-pip-wheel may be listed by rpm but pip is absent from PATH until
# the package is installed explicitly. dnf is idempotent (no-op if present).
if ! command -v pip3 &>/dev/null && ! python3 -m pip --version &>/dev/null 2>&1; then
    echo "pip3 not found — installing python3-pip via dnf..."
    dnf install -y python3-pip 2>/dev/null || true
fi

# Install Python dependencies (quiet, idempotent)
pip3 install -q -r "${SCRIPT_DIR}/requirements.txt" 2>/dev/null || true

# Delegate to Python
exec python3 "${SCRIPT_DIR}/bootstrap_argocd.py" "$@"
