---
title: "ADR-0007: K8s Job Image URIs from ConfigMap File Mounts Instead of Environment Variables"
type: decision
tags: [kubernetes, configmap, eso, image-uri, job, argocd, image-updater, admin-api]
sources:
  - api/admin-api/src/lib/config.ts
  - api/admin-api/__tests__/lib/config.test.ts
created: 2026-04-28
updated: 2026-04-28
---

<!-- Migrated from tucaken-infra/docs/decisions/0008-k8s-job-images-from-configmap-files.md on 2026-06-16. Run kb-doc in this repo to integrate properly. ADR mechanism (ArgoCD / Argo Rollouts / Image Updater / ESO ConfigMap) is owned by kubernetes-bootstrap. -->

# ADR-0007: K8s Job Image URIs from ConfigMap File Mounts Instead of Environment Variables

**Date:** 2026-04-28
**Status:** Accepted
**Deciders:** Nelson Lamounier (solo developer)

---

## Status

Accepted. Implemented in commit `78f6e724` — `feat(admin-api): resolve K8s Job image URIs from /etc/admin-api/images/* files`.

---

## Context

admin-api launches three types of Kubernetes Jobs on demand: `ingestion`, `article-pipeline`, and `job-strategist`. Each Job requires a fully-qualified ECR image URI (`<account>.dkr.ecr.<region>.amazonaws.com/<app>:<tag>`) to create the Job spec.

Before this decision, the three image URIs were fields on `AdminApiConfig`, populated from environment variables (`INGESTION_IMAGE`, `ARTICLE_PIPELINE_IMAGE`, `STRATEGIST_PIPELINE_IMAGE`) injected into the pod at startup. This approach coupled image-tag updates to admin-api pod restarts: every time a new ingestion image was pushed, admin-api itself needed to be restarted (or redeployed) to pick up the new URI.

The project uses ArgoCD Image Updater to track ECR for the admin-api image. However, the three Job images live in separate ECR repositories and are independently versioned — they are not the same image as admin-api. Tracking all four images in a single `INGESTION_IMAGE` env var approach would require either a pod restart per Job image update or a custom webhook mechanism.

The Kubernetes kubelet automatically refreshes Secret-backed volume mounts when the underlying Secret changes, with a propagation delay of approximately 60 seconds. External Secrets Operator (ESO) syncs SSM parameter values into Kubernetes Secrets. Combining these two mechanisms makes it possible to update a Job image URI in SSM and have the running admin-api pod see the new value within approximately 60–90 seconds — without restarting the pod.

Sources: `api/admin-api/src/lib/config.ts` header docblock lines 1–23; commit message `78f6e724`.

---

## Decision

The three K8s Job image URIs are resolved at request time by reading files from a directory mount, not from environment variables loaded at pod startup.

- The Helm chart mounts an ESO-synced Secret (`admin-api-job-images`) as a directory at `/etc/admin-api/images/` (configurable via `JOB_IMAGES_DIR` env var).
- Each file in that directory is named after the logical job: `ingestion`, `article-pipeline`, `job-strategist`.
- The function `getJobImage(name)` reads the file, trims whitespace, and returns the URI. It caches the result for 30 seconds to avoid a filesystem read on every Job-creation request during sustained traffic.
- If the file is absent (e.g., local development without the mount), `getJobImage()` falls back to an environment variable (`INGESTION_IMAGE`, `ARTICLE_PIPELINE_IMAGE`, `STRATEGIST_PIPELINE_IMAGE`). If neither the file nor the env var is set, it returns the sentinel value `UNSET_IMAGE_SENTINEL = 'image-uri-not-yet-set'`.
- Before creating any Job, every route calls `isImageConfigured(uri)`. If `isImageConfigured` returns `false`, the route returns HTTP 502 with an explicit message instructing the operator to check ESO/kubelet sync status.
- Image URIs are **not** fields on `AdminApiConfig` — the config object is loaded once at startup from required env vars; image URIs are excluded intentionally. Source: `api/admin-api/src/lib/config.ts` line 157 comment.

The SSM source paths for the three images are `/k8s/<env>/job-images/ingestion`, `/k8s/<env>/job-images/article-pipeline`, and `/k8s/<env>/job-images/job-strategist`, written by the `ai-applications` repository CI workflows on each ECR push. Source: commit `78f6e724` message body.

---

## Consequences

**Benefits:**

- Job image updates propagate to running pods without an admin-api redeployment. The kubelet refreshes the mounted Secret files when ESO rotates the underlying Secret (~60s propagation). The 30-second in-process cache means the new URI is picked up within ~90 seconds of the SSM write.
- Each of the three Job images can be updated independently. An ingestion release does not affect article-pipeline or job-strategist URI resolution.
- The 502 guard (`isImageConfigured`) prevents creating a Job with a garbage or missing image URI, which would result in a `CrashLoopBackOff` / `ImagePullBackOff` on the spawned pod. The failure is surfaced immediately at the API layer rather than buried in a K8s Job event. Source: `api/admin-api/src/lib/config.ts` lines 34–39.
- Local development and test environments work without a mounted Secret by falling back to env vars. The full resolution chain (file → env var → sentinel) is exercised in `api/admin-api/__tests__/lib/config.test.ts` lines 191–226.

**Trade-offs:**

- The 30-second cache means a burst of requests during the 0–30s window after a file change will all use the stale URI. This is acceptable: Job-creation requests are low-frequency, and the cache TTL is short relative to the deployment cycle.
- The file-mount approach requires ESO to be healthy and the `admin-api-job-images` Secret to be present. If ESO has not yet synced on a fresh deployment, `getJobImage()` returns the sentinel and all Job-creation routes return 502 until the Secret appears.
- The Rollout spec and the `admin-api-job-images` ExternalSecret live in the `kubernetes-bootstrap` repository (noted in commit `78f6e724`: "Pairs with kubernetes-bootstrap commit 859760e"). The full deployment dependency chain spans two repositories.

---

## Alternatives Considered

### Environment variables loaded at pod startup

The prior approach. Image URI changes require an admin-api pod restart or full redeployment. Rejected because it couples unrelated release cycles: an ingestion image push should not cause an admin-api rollout.

### Polling SSM directly from admin-api on each request

Would eliminate the ESO/kubelet chain and allow direct SDK reads from SSM with any TTL. Rejected because it adds an AWS SDK call in the hot path of every Job-creation request, increases IAM surface, and bypasses the standard ESO Secret sync pattern used everywhere else in the cluster.

### ArgoCD Image Updater for all four images

Image Updater is already tracking the admin-api ECR repo. Extending it to also write Job image URIs into the same `Rollout` spec would require complex annotation patterns for multiple images and would still trigger a pod restart on each update. Rejected because the file-mount approach avoids restarts entirely.

<!-- evidence-trail
  api/admin-api/src/lib/config.ts: lines 1–106 — full getJobImage() and isImageConfigured() implementation read
  api/admin-api/__tests__/lib/config.test.ts: lines 173–227 — getJobImage() test coverage confirmed
  git show 78f6e724 --stat: commit message, changed files, and cross-repo pairing note confirmed
-->
