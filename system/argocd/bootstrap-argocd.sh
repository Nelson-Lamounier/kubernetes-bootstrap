#!/usr/bin/env bash
# bootstrap-argocd.sh — Thin wrapper for the TypeScript ArgoCD bootstrap.
#
# Preserves compatibility with callers expecting a .sh entrypoint
# (control_plane.ts invokes this file directly).
#
# Usage:
#   KUBECONFIG=/etc/kubernetes/admin.conf bash bootstrap-argocd.sh
#   KUBECONFIG=/etc/kubernetes/admin.conf bash bootstrap-argocd.sh --dry-run

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

exec npx tsx "${SCRIPT_DIR}/bootstrap_argocd.ts" "$@"
