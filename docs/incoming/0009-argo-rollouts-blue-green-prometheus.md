---
title: "ADR-0008: Argo Rollouts Blue/Green with Prometheus Pre-Promotion Analysis for admin-api"
type: decision
tags: [argo-rollouts, blue-green, prometheus, traefik, gitops, argocd, image-updater, admin-api, deployment]
sources:
  - .github/workflows/deploy-api.yml
created: 2026-04-28
updated: 2026-04-28
---

<!-- Migrated from tucaken-infra/docs/decisions/0009-argo-rollouts-blue-green-prometheus.md on 2026-06-16. Run kb-doc in this repo to integrate properly. ADR mechanism (ArgoCD / Argo Rollouts / Image Updater / ESO ConfigMap) is owned by kubernetes-bootstrap. -->

# ADR-0008: Argo Rollouts Blue/Green with Prometheus Pre-Promotion Analysis for admin-api

**Date:** 2026-04-28
**Status:** Accepted
**Deciders:** Nelson Lamounier (solo developer)

---

## Status

Accepted. Described in `.github/workflows/deploy-api.yml` comment block (lines 1–37). The Rollout spec and AnalysisTemplate live in the `kubernetes-bootstrap` repository (cross-repo reference — see Consequences).

---

## Context

The admin-api is the primary backend for the Tucaken platform. Deploying a bad image directly to the running pod risks downtime that is observable in Traefik metrics (elevated error rate, degraded P95 latency).

The previous deployment flow used a dedicated GitHub Actions job (`deploy-admin-api`) that ran on a self-hosted ARC runner, wrote the image URI to SSM (`/admin-api/<env>/image-uri`), and called `deploy.py` to perform a rolling restart. This approach had three weaknesses:

1. It relied on shell-level tooling (`deploy.py`) that was fragile and difficult to test.
2. Promotion was immediate — there was no automated gate to verify the new version was healthy before it received production traffic.
3. All Kubernetes-level operations were co-located with the build pipeline in this repository, creating an implicit coupling between `cdk-monitoring` and cluster state.

The project already runs ArgoCD and Argo Rollouts on the cluster. The decision was made to move all Kubernetes-level deploy operations to the `kubernetes-bootstrap` repository (which owns all K8s manifests via ArgoCD GitOps) and use Argo Rollouts to enforce a pre-promotion analysis gate. Source: `.github/workflows/deploy-api.yml` lines 6–26.

---

## Decision

The admin-api deployment uses a fully GitOps pipeline with an automated quality gate:

1. **This repository** (cdk-monitoring) only builds and pushes the Docker image to ECR. The `deploy-api.yml` workflow has no `kubectl`, no SSM writes for the admin-api image, and no `deploy.py`. It runs two jobs: `build-admin-api` and `push-admin-api`. Source: `.github/workflows/deploy-api.yml` lines 65–176.

2. **ArgoCD Image Updater** runs cluster-resident and polls the admin-api ECR repository. When it detects a new tag, it writes the updated image reference into `.argocd-source-admin-api.yaml` (a generated file in `kubernetes-bootstrap`). ArgoCD reconciles the generated Application, and Helm renders the `Rollout` resource with the new image.

3. **Argo Rollouts** drives Blue/Green for the admin-api `Rollout`. After the green (preview) pods start, a pre-promotion **AnalysisRun** executes against live Prometheus metrics before any traffic is shifted:
   - Prometheus error-rate metric (sourced from Traefik ingress metrics)
   - Prometheus P95 latency metric (sourced from Traefik ingress metrics)

4. **Manual promotion gate:** Automatic promotion is not configured. Promotion requires an explicit command: `kubectl argo rollouts promote admin-api -n admin-api`. Alternatively, a `workflow_dispatch` in the `kubernetes-bootstrap` repository can trigger promotion via the in-cluster ARC runner — that repository owns all K8s-level operations. Source: `.github/workflows/deploy-api.yml` lines 14–17.

The ECR repository URI is provisioned by the CDK `SharedVpcStack` and published to SSM at `/shared/ecr-admin-api/<env>/repository-uri`. The workflow reads this value at push time. Source: `.github/workflows/deploy-api.yml` lines 143–158 and lines 35–37.

The Rollout spec and AnalysisTemplate are defined in the `kubernetes-bootstrap` repository. They are not duplicated here.

---

## Consequences

**Benefits:**

- Bad deployments are caught before production traffic shifts. The Prometheus error-rate and P95 latency gates are derived from live Traefik metrics — they reflect actual end-user observable behaviour, not synthetic checks.
- The `cdk-monitoring` repository is decoupled from Kubernetes state. This repository does one thing: build and push. All cluster state is owned by `kubernetes-bootstrap`.
- The manual promotion gate provides a human checkpoint. An engineer can inspect green pod logs and metrics before promoting, regardless of whether the AnalysisRun passes.
- ArgoCD Image Updater eliminates SSM-mediated image tracking for the admin-api image. The previous pattern (write URI to SSM, read in deploy.py) is fully replaced by Image Updater writing directly to git. Source: `.github/workflows/deploy-api.yml` lines 18–26 (obsolete items listed explicitly).

**Trade-offs:**

- The full deployment path crosses two repositories: `cdk-monitoring` (build/push) and `kubernetes-bootstrap` (Rollout spec, AnalysisTemplate, Image Updater config). Debugging a failed deployment may require checking both repositories.
- The Rollout spec and AnalysisTemplate are not visible from this repository. Anyone reading this ADR must consult `kubernetes-bootstrap` (referenced commit `859760e` in the ai-applications cross-repo note from commit `78f6e724`) to inspect the full Blue/Green configuration and Prometheus query thresholds.
- Manual promotion means a deployment is never fully automated end-to-end. A forgotten promotion leaves the green pods running in preview indefinitely. This is an accepted trade-off for a portfolio project where safety takes priority over automation speed.

---

## Alternatives Considered

### Fully automated promotion (no manual gate)

Argo Rollouts supports automatic promotion after a passing AnalysisRun. Rejected for this deployment because the Tucaken platform is in active development; having a human checkpoint before traffic shifts reduces risk during frequent image updates.

### Keep deploy.py with rolling restart

The original approach. Rejected because it provides no quality gate, couples this repository to cluster state, and requires maintaining shell-level tooling that has no test coverage. Explicitly called out as obsolete in `.github/workflows/deploy-api.yml` lines 18–26.

### Rolling update (RollingUpdate strategy) instead of Blue/Green

Rolling updates replace pods gradually but route traffic to new pods before analysis is complete. Blue/Green holds all production traffic on the blue (stable) pods until the AnalysisRun passes, providing a cleaner separation between the test period and promotion. Rejected rolling updates because they make mid-deploy rollback harder and do not support a pre-promotion analysis gate.

<!-- evidence-trail
  .github/workflows/deploy-api.yml: lines 1–176 read in full
  Lines 6–17: GitOps rationale, Argo Rollouts Blue/Green, Prometheus metrics, manual promotion command
  Lines 18–26: explicit list of obsolete prior approach (deploy.py, SSM writes, k8s-runner)
  Lines 65–176: workflow job definitions confirming no kubectl/deploy.py steps
  Lines 143–158: ECR URI resolution from SSM /shared/ecr-admin-api/{env}/repository-uri
  Rollout spec confirmed to be in kubernetes-bootstrap (cross-repo) — not fabricated
-->
