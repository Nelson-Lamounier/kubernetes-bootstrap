#!/usr/bin/env bash
# deploy-manifests.sh — Thin wrapper for Python deploy script.
#
# Preserves SSM State Manager association compatibility (expects .sh entrypoint).
# Installs Python dependencies and delegates to deploy.py.
#
# Usage:
#   KUBECONFIG=/etc/kubernetes/admin.conf bash deploy-manifests.sh
#   KUBECONFIG=/etc/kubernetes/admin.conf bash deploy-manifests.sh --dry-run

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Install Python dependencies (quiet, idempotent)
pip3 install -q -r "${SCRIPT_DIR}/requirements.txt" 2>/dev/null || true

# Delegate to Python
exec python3 "${SCRIPT_DIR}/deploy.py" "$@"
