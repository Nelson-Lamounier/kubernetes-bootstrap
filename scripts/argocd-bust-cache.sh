#!/usr/bin/env bash
# @format
# argocd-bust-cache.sh — clear the application-controller's stale
# manifest cache and trigger a hard refresh on one or more ArgoCD
# Applications.
#
# Use this when:
#   • An image tag was committed but ArgoCD still reports the old one.
#   • `argocd.argoproj.io/refresh=hard` and a repo-server restart did
#     not clear it.
#
# Why it works:
#   Restarting argocd-application-controller flushes the controller's
#   in-memory resource cache (the cache the hard-refresh annotation
#   does NOT flush). The hard-refresh annotation then forces the
#   repo-server to re-render from Git on the next reconcile.
#
# Blast radius:
#   ~5 second reconcile pause while the controller pod cycles. No
#   workload impact — controller state lives in etcd.
#
# Usage:
#   ./scripts/argocd-bust-cache.sh <app> [<app> ...]
#   ./scripts/argocd-bust-cache.sh --all      # all Applications in argocd ns
#
# Full runbook: docs/runbooks/argocd-stale-manifest-cache.md

set -euo pipefail

NS=argocd
STS=argocd-application-controller

if [[ $# -eq 0 ]]; then
  echo "usage: $0 <app> [<app> ...] | --all" >&2
  exit 64
fi

if [[ "${1:-}" == "--all" ]]; then
  mapfile -t APPS < <(kubectl get applications -n "$NS" --no-headers -o custom-columns=":metadata.name")
else
  APPS=("$@")
fi

echo "→ restarting $STS (clears controller resource cache)…"
kubectl rollout restart statefulset "$STS" -n "$NS"
kubectl rollout status   statefulset "$STS" -n "$NS" --timeout=120s

echo "→ patching ${#APPS[@]} Application(s) with refresh=hard…"
for app in "${APPS[@]}"; do
  kubectl patch application "$app" -n "$NS" \
    --type merge \
    -p '{"metadata":{"annotations":{"argocd.argoproj.io/refresh":"hard"}}}' \
    >/dev/null
  echo "    • $app"
done

echo "→ watching convergence (Ctrl-C to exit)…"
kubectl get applications -n "$NS" "${APPS[@]}" -w \
  -o custom-columns=NAME:.metadata.name,SYNC:.status.sync.status,HEALTH:.status.health.status,REV:.status.sync.revision
