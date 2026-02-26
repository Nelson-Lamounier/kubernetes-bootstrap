#!/usr/bin/env bash
# bootstrap-argocd.sh — Thin wrapper for Python bootstrap script.
#
# Preserves boot-k8s.sh compatibility (expects .sh entrypoint).
# Installs Python dependencies and delegates to bootstrap_argocd.py.
#
# Usage:
#   KUBECONFIG=/etc/kubernetes/admin.conf bash bootstrap-argocd.sh
#   KUBECONFIG=/etc/kubernetes/admin.conf bash bootstrap-argocd.sh --dry-run

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Install Python dependencies (quiet, idempotent)
pip3 install -q -r "${SCRIPT_DIR}/requirements.txt" 2>/dev/null || true

# Delegate to Python
exec python3 "${SCRIPT_DIR}/bootstrap_argocd.py" "$@"
