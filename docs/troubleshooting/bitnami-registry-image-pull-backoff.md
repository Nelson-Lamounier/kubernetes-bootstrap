---
title: Bitnami docker.io Images Purged — ImagePullBackOff After Registry Migration
type: troubleshooting
tags: [kubernetes, helm, registry, bitnami, imagepullbackoff, pgbouncer]
sources:
  - charts/platform-rds/chart/values.yaml
created: 2026-04-29
updated: 2026-04-29
---

# Bitnami docker.io Images Purged — ImagePullBackOff After Registry Migration

## Symptom

A pod using a Bitnami Helm chart image stays in `ImagePullBackOff` after a cluster rebuild or node replacement. The event log shows a 404 or "image not found" error from `docker.io`:

```
Failed to pull image "docker.io/bitnami/pgbouncer:1.23.1":
  rpc error: code = NotFound desc = failed to pull and unpack image
  "docker.io/bitnami/pgbouncer:1.23.1": unexpected status code 404/Not Found
```

The image was pullable before — the cluster worked on the previous node because the image was cached locally. On the replacement node there is no cache, and the pull fails.

## Root cause

Bitnami purged most images from `docker.io/bitnami/*` in 2025 and moved archived tags to `docker.io/bitnamilegacy/*`. Any Helm chart pinned to a tag released before the purge date will get a 404 from `docker.io/bitnami/` on any node that does not have the image cached.

The `bitnamilegacy` repository is **read-only and frozen** — no new patch or minor versions are published there. It is a permanent archive, not an actively maintained registry.

Source: `charts/platform-rds/chart/values.yaml` lines 5–11:

```yaml
pgbouncer:
  image:
    # Bitnami purged most images from docker.io/bitnami/* in 2025 and moved
    # the archived tags under docker.io/bitnamilegacy/*. Pinning here to
    # keep the cluster pullable; review for a maintained alternative
    # (Bitnami Premium, official Postgres + sidecar, or edoburu/pgbouncer)
    # before next major upgrade.
    repository: bitnamilegacy/pgbouncer
    tag: "1.23.1"
```

Commit: `fc322c1` (`fix(platform-rds): pull pgbouncer from bitnamilegacy registry`).

## How to diagnose

```bash
# 1. Identify the failing pod and its image
kubectl get pods -A | grep -i "imagepull\|errimage"
kubectl describe pod <pod-name> -n <namespace> | grep -A5 "Failed to pull"

# 2. Test whether the image exists on docker.io
docker pull docker.io/bitnami/<image>:<tag> 2>&1 | grep -i "404\|not found\|pulling"

# 3. Test whether the bitnamilegacy equivalent exists
docker pull docker.io/bitnamilegacy/<image>:<tag> 2>&1 | grep -i "404\|not found\|pulled"

# 4. Check what repository the Helm chart currently uses
helm get values <release-name> -n <namespace> | grep repository
```

## How to fix

### Switch to the bitnamilegacy repository (stopgap)

For an existing Bitnami chart where the image was pulled from `docker.io/bitnami/`:

```bash
# Update the values file or chart values to use bitnamilegacy/
# Example for pgbouncer:
helm upgrade <release-name> <chart> -n <namespace> \
  --set pgbouncer.image.repository=bitnamilegacy/pgbouncer \
  --set pgbouncer.image.tag=1.23.1 \
  --reuse-values
```

Or update `values.yaml` directly:

```yaml
pgbouncer:
  image:
    repository: bitnamilegacy/pgbouncer  # changed from docker.io/bitnami/pgbouncer
    tag: "1.23.1"
```

Verify the pod starts:

```bash
kubectl rollout status deployment/<deployment-name> -n <namespace>
kubectl get pods -n <namespace> | grep <app-name>
```

### Migrate to a maintained alternative (recommended before next major bump)

The `bitnamilegacy` workaround is a temporary fix. The commit note (`fc322c1`) lists three options evaluated at the time:

| Alternative | Status | Notes |
|-------------|--------|-------|
| `Bitnami Premium` (paid) | Actively maintained | Requires a paid Bitnami subscription |
| `edoburu/pgbouncer` | Community-maintained | Not an official Bitnami product |
| Official Postgres image + pgbouncer sidecar | No external dependency | Requires Helm chart changes |

For pgbouncer specifically: `edoburu/pgbouncer` is a widely-used community image. Evaluate its version freshness and CVE cadence before adopting.

## How to prevent

**Check all Bitnami chart images during cluster rebuild planning.** Any tag that was published before the 2025 purge will hit a 404 on the first pull from `docker.io/bitnami/`. Images cached from a previous node are not reliable — they disappear on node replacement.

Scan current charts for `docker.io/bitnami` references:

```bash
grep -rn "bitnami/" charts/ --include="*.yaml" | grep "repository:" | grep -v "bitnamilegacy"
```

Any match using `docker.io/bitnami/` (or just `bitnami/` without `legacy`) should be updated to `bitnamilegacy/` or a maintained alternative before the next cluster rebuild.

**Before upgrading a Bitnami chart to a new major version:** verify that the new tag exists on `bitnamilegacy/` or on an alternative registry. `bitnamilegacy` is frozen — new major versions are not published there, only tags archived before the purge.

## Related

- [ESO ExternalSecret Not Syncing](eso-external-secret-not-syncing.md) — another pod startup blocker during cluster cold start

<!--
Evidence trail (auto-generated):
- Source: charts/platform-rds/chart/values.yaml (read 2026-04-29 — lines 5-11, comment text verbatim, bitnamilegacy repository pin)
- Commit: fc322c1 fix(platform-rds): pull pgbouncer from bitnamilegacy registry — root cause analysis in commit body, remediation options listed
- Generated: 2026-04-29
-->
