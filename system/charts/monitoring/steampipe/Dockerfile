FROM debian:bookworm-slim

# ── Install latest Steampipe CLI + AWS plugin ────────────────────────
# The official ghcr.io/turbot/steampipe:latest image ships v0.22.0
# which has a known bug causing 403 when pulling plugins from the
# Steampipe OCI registry. Steampipe v2.x fixes this.

ARG STEAMPIPE_VERSION=2.4.0
ARG TARGETARCH=amd64

# Install Steampipe
RUN apt-get update -qq \
    && apt-get install -y -qq --no-install-recommends curl ca-certificates \
    && curl -sSL \
    "https://github.com/turbot/steampipe/releases/download/v${STEAMPIPE_VERSION}/steampipe_linux_${TARGETARCH}.tar.gz" \
    | tar -xz -C /usr/local/bin \
    && useradd -m steampipe \
    && apt-get remove -y curl && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/*

# Switch to steampipe user and install the AWS plugin
USER steampipe
WORKDIR /home/steampipe
RUN steampipe plugin install aws

ENTRYPOINT ["steampipe"]
