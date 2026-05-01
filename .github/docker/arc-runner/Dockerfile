# =============================================================================
# ARC Self-Hosted Runner Image — kubernetes-bootstrap
# =============================================================================
#
# Extends the official ARC runner with deploy tooling pre-installed:
#   Node.js 22 + Yarn 4 (via Corepack), AWS CLI v2, kubectl,
#   python3-full (venv + pip)
#
# Node.js + Yarn are required so setup-node-yarn/action.yml correctly
# detects this as a CI container and skips redundant tool installation.
#
# Built and pushed to GHCR by .github/workflows/build-ci-image.yml.
#
# Usage in system/arc/arc-runners.yaml (ArgoCD Application Helm values):
#   template:
#     spec:
#       containers:
#         - name: runner
#           image: ghcr.io/nelson-lamounier/kubernetes-bootstrap/arc-runner:latest
# =============================================================================

FROM ghcr.io/actions/actions-runner:latest

USER root

# ── System dependencies ──────────────────────────────────────────────────────
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    gnupg \
    unzip \
    python3-full \
    python3-pip \
    python3-venv \
    && rm -rf /var/lib/apt/lists/*

# ── Node.js 22 ───────────────────────────────────────────────────────────────
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/* \
    && node --version

# ── Yarn 4 via Corepack ──────────────────────────────────────────────────────
# COREPACK_INTEGRITY_KEYS=0 skips the public-key network check that blocks
# air-gapped / cached builds. Integrity is still enforced by the lockfile.
ENV COREPACK_INTEGRITY_KEYS=0
RUN corepack enable \
    && corepack prepare yarn@4.14.0 --activate \
    && yarn --version

# ── AWS CLI v2 ───────────────────────────────────────────────────────────────
RUN curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o /tmp/awscliv2.zip \
    && unzip -q /tmp/awscliv2.zip -d /tmp \
    && /tmp/aws/install \
    && rm -rf /tmp/aws /tmp/awscliv2.zip \
    && aws --version

# ── kubectl (latest stable) ──────────────────────────────────────────────────
RUN KUBECTL_VERSION=$(curl -sL https://dl.k8s.io/release/stable.txt) \
    && curl -sLO "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/amd64/kubectl" \
    && chmod +x kubectl \
    && mv kubectl /usr/local/bin/kubectl \
    && kubectl version --client

# ── kubectl-argo-rollouts plugin (latest stable) ─────────────────────────────
RUN ARGO_VERSION=$(curl -sL https://api.github.com/repos/argoproj/argo-rollouts/releases/latest \
      | grep '"tag_name"' | head -1 | sed 's/.*"tag_name": "\(.*\)".*/\1/') \
    && curl -sLo /usr/local/bin/kubectl-argo-rollouts \
      "https://github.com/argoproj/argo-rollouts/releases/download/${ARGO_VERSION}/kubectl-argo-rollouts-linux-amd64" \
    && chmod +x /usr/local/bin/kubectl-argo-rollouts \
    && kubectl-argo-rollouts version

USER runner

ENTRYPOINT ["/home/runner/run.sh"]
