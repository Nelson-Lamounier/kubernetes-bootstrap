# =============================================================================
# CI Toolchain Image for GitHub Actions
# =============================================================================
#
# Deterministic toolchain image that replaces per-job setup-* actions.
# Built and pushed to GHCR by .github/workflows/build-ci-image.yml.
#
# Tools included:
#   Node.js 22, Corepack (Yarn 4), Just, Helm, AWS CLI v2,
#   Python 3 + checkov + cfn-lint, git, jq, curl
#
# Usage in workflows:
#   jobs:
#     deploy:
#       runs-on: ubuntu-latest
#       container:
#         image: ghcr.io/${{ github.repository }}/ci:latest
# =============================================================================

FROM node:22-slim

LABEL org.opencontainers.image.source="https://github.com/Nelson-Lamounier/kubernetes-bootstrap"
LABEL org.opencontainers.image.description="CI toolchain image with Node.js, AWS CLI, CDK, Helm, Just, and Python linting tools"

# ── System dependencies ──────────────────────────────────────────────────────
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    git \
    jq \
    unzip \
    python3 \
    python3-pip \
    python3-venv \
    ca-certificates \
    gnupg \
    && rm -rf /var/lib/apt/lists/*

# ── AWS CLI v2 ───────────────────────────────────────────────────────────────
RUN curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o /tmp/awscliv2.zip \
    && unzip -q /tmp/awscliv2.zip -d /tmp \
    && /tmp/aws/install \
    && rm -rf /tmp/aws /tmp/awscliv2.zip \
    && aws --version

# ── Just (task runner) ───────────────────────────────────────────────────────
ARG JUST_VERSION=1.46.0
RUN curl -fsSL "https://github.com/casey/just/releases/download/${JUST_VERSION}/just-${JUST_VERSION}-x86_64-unknown-linux-musl.tar.gz" \
    | tar xz -C /usr/local/bin just \
    && chmod +x /usr/local/bin/just \
    && just --version

# ── Helm ─────────────────────────────────────────────────────────────────────
ARG HELM_VERSION=3.17.1
RUN curl -fsSL "https://get.helm.sh/helm-v${HELM_VERSION}-linux-amd64.tar.gz" \
    | tar xz -C /tmp \
    && mv /tmp/linux-amd64/helm /usr/local/bin/helm \
    && rm -rf /tmp/linux-amd64 \
    && helm version --short

# ── Python tools (checkov, cfn-lint) in isolated venv ────────────────────────
RUN python3 -m venv /opt/ci-tools \
    && /opt/ci-tools/bin/pip install --no-cache-dir --upgrade pip \
    && /opt/ci-tools/bin/pip install --no-cache-dir checkov cfn-lint
ENV PATH="/opt/ci-tools/bin:$PATH"

# ── Corepack for Yarn 4 ─────────────────────────────────────────────────────
RUN corepack enable

# ── Verification ─────────────────────────────────────────────────────────────
RUN echo "=== CI Image Tool Versions ===" \
    && node --version \
    && npm --version \
    && corepack --version \
    && just --version \
    && helm version --short \
    && aws --version \
    && python3 --version \
    && checkov --version \
    && cfn-lint --version \
    && git --version \
    && jq --version \
    && echo "=== All tools verified ==="

# ── Safe directory for git (GitHub Actions mounts workspace) ─────────────────
RUN git config --global --add safe.directory '*'

WORKDIR /workspace
