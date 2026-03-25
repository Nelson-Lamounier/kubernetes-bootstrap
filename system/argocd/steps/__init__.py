"""Steps package for ArgoCD bootstrap.

Each module handles a logical group of bootstrap steps:
  - namespace: Steps 1–3b (namespace, deploy key, repo secret, signing key preserve)
  - install:   Steps 4–4d (install, project, server config, health checks)
  - apps:      Steps 5–5d (root apps, monitoring, ECR, Crossplane, TLS restore, cert-manager)
  - networking: Steps 6–7c (readiness wait, ingress, IP allowlist, webhook)
  - auth:      Steps 8–11 (CLI, CI bot, token, admin password, TLS backup, signing key backup, summary)
"""
