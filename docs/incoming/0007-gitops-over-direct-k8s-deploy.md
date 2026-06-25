<!-- Migrated from tucaken-infra/docs/decisions/0007-gitops-over-direct-k8s-deploy.md on 2026-06-16. Run kb-doc in this repo to integrate properly. ADR mechanism (ArgoCD / Argo Rollouts / Image Updater / ESO ConfigMap) is owned by kubernetes-bootstrap. -->

# ADR-006: GitOps via ArgoCD Image Updater over Direct Kubernetes Deploy

**Date:** 2026-04-28
**Status:** Accepted
**Deciders:** Nelson Lamounier (solo developer)

---

## Context

The `deploy-api.yml` workflow originally contained a `deploy-admin-api` job that ran on the `k8s-runner` Actions Runner Controller (ARC) self-hosted runner. That job performed three operations after building the Docker image:

1. Wrote the new image URI to AWS SSM Parameter Store at `/admin-api/{env}/image-uri`.
2. Invoked `deploy.py` — a Python script that shelled out to `kubectl` to update the Kubernetes Deployment.
3. Waited for the rollout to complete before marking the job as successful.

This approach created several coupling problems as the platform matured:

- **SSM path conflict.** The Job images (AI batch workloads) use a different SSM path (`/k8s/{env}/job-images/{app}`) written by the `ai-applications` workflows and consumed by External Secrets Operator. The admin-api SSM path was a parallel, non-standard convention with no other consumers after the GitOps migration began.
- **`deploy.py` decommissioned.** `deploy.py` was removed post-Phase-2 when the cluster bootstrapping strategy moved to ArgoCD-managed Helm Rollouts. The script had no maintained replacement and its Python dependencies were a recurring source of PEP 668 venv compliance failures (commit `a247a5ae`).
- **k8s-runner dependency.** The deploy job required a healthy self-hosted ARC runner in the cluster. ARC runner registration is fragile on a single-node cluster; a scale set rename was required to force fresh GitHub registration (commit `42bf1008`). Any cluster maintenance window blocked the entire deploy pipeline.
- **Operational ownership boundary.** The `kubernetes-bootstrap` repository now owns all Kubernetes-level operations via ArgoCD ApplicationSets and Argo Rollouts. Having `cdk-monitoring` workflows also write Kubernetes state created split ownership.

Concurrently, ArgoCD Image Updater was already deployed in the cluster and configured on the `admin-api` ApplicationSet in `kubernetes-bootstrap/argocd-apps/admin-api.yaml`. It polls ECR independently and writes the new image tag into `.argocd-source-admin-api.yaml`, triggering an ArgoCD reconciliation without any GitHub Actions involvement.

---

## Decision

The `deploy-admin-api` job was removed from `deploy-api.yml`. The workflow now stops at ECR push. All Kubernetes-level operations — image tag propagation, Helm rendering, rollout execution — are delegated to ArgoCD Image Updater and Argo Rollouts running in the cluster.

The full deployment path after this change is (`.github/workflows/deploy-api.yml`, lines 1–38):

```
build-admin-api → push-admin-api → [ECR]
                                        ↓  (no GHA runner)
                          Image Updater polls ECR
                                        ↓
                          ArgoCD reconciles ApplicationSet
                                        ↓
                          Argo Rollouts drives Blue/Green
                          (Prometheus error-rate + P95 latency analysis)
                                        ↓
                          Manual promotion:
                          kubectl argo rollouts promote admin-api -n admin-api
                          (or workflow_dispatch on kubernetes-bootstrap ARC runner)
```

The image tag format `{github.sha}-r{github.run_attempt}` is preserved in the ECR push, providing full traceability from commit to deployed image (`.github/workflows/deploy-api.yml`, line 59).

---

## Consequences

### Benefits

- **No GHA runner in the critical path for deploys.** A cluster maintenance window, ARC registration failure, or runner capacity issue no longer blocks image promotion to the cluster.
- **Kubernetes-level operations owned exclusively by `kubernetes-bootstrap`.** No split ownership between repositories for the same cluster.
- **`deploy.py` and its dependency chain removed.** Eliminates the Python venv, `kubectl` binary, and SSM write from the deploy workflow. The workflow surface is smaller and easier to audit.
- **Blue/Green promotion with automated analysis.** Argo Rollouts drives promotion based on live Prometheus metrics (error rate and P95 latency from Traefik) rather than a time-based `kubectl rollout status` wait. This is a stronger correctness guarantee.
- **SSM path hygiene.** The non-standard `/admin-api/{env}/image-uri` parameter is no longer written. Job image paths follow the single convention at `/k8s/{env}/job-images/{app}`.

### Trade-offs accepted

- **No GHA job confirms rollout success.** The `deploy-api.yml` workflow exits after ECR push. Whether Image Updater has picked up the tag and whether the Argo Rollout succeeded is observable only via ArgoCD UI, Argo Rollouts CLI, or Grafana — not from the GitHub Actions run page.
- **Manual promotion gate.** Blue/Green promotion requires a manual `kubectl argo rollouts promote` command or a `workflow_dispatch` on `kubernetes-bootstrap`. This is intentional (prevents automatic promotion of a bad image past the analysis phase) but adds a human step to every deploy.
- **Image Updater polling latency.** Image Updater polls ECR on a configurable interval. There is a delay between the ECR push completing and ArgoCD beginning reconciliation. For development environments this is acceptable.

---

## Alternatives Considered

### Keep the k8s-runner deploy job, fix the ARC registration issue

The ARC rename fix (commit `42bf1008`) stabilised the runner temporarily, but the fundamental fragility remained: any cluster downtime blocks the deploy pipeline. This also did not address the `deploy.py` decommission or the split ownership concern.

**Rejected** because it treated symptoms rather than causes.

### Replace `deploy.py` with a `kubectl set image` step in GHA

`kubectl set image deployment/admin-api admin-api={ecr-url}:{tag}` would avoid `deploy.py` while keeping GHA in the deploy path. However, this would still require the k8s-runner ARC runner, would bypass Argo Rollouts Blue/Green analysis, and would conflict with ArgoCD's self-heal (ArgoCD would immediately revert a live `kubectl` mutation that did not go through Helm).

**Rejected** because it conflicts with the GitOps model already in place.

### Use a GitHub Actions environment with a wait step polling ArgoCD API

A step could poll the ArgoCD API to confirm sync status after the ECR push, effectively re-coupling GHA to the rollout without requiring a cluster runner. This would restore the "deploy confirmed" feedback in the GHA UI.

**Not implemented** because the kubernetes-bootstrap repo owns the ArgoCD ApplicationSet, and exposing the ArgoCD API externally for GHA polling adds attack surface. The trade-off was accepted in favour of in-cluster observability (Grafana, Argo Rollouts UI).

---

*Commit implementing this decision: `aba4cc79` — `ci(admin-api): drop k8s-runner deploy job — GitOps via ArgoCD Image Updater`*

<!--
Evidence trail (auto-generated):
- Source: .github/workflows/deploy-api.yml (read on 2026-04-28) — comment block lines 1-38, job definitions lines 65-176
- Git: git log --oneline -- .github/workflows/deploy-api.yml (run on 2026-04-28) — commits aba4cc79, 4bb224e6, fee0ef6a, efef710a, 1048cdfe, 42bf1008, a247a5ae
- Git: git log --oneline --all | grep -i "gitops|k8s-runner|argocd|deploy.py" (run on 2026-04-28)
- Source: docs/adrs/0001-self-managed-k8s-vs-eks.md (read on 2026-04-28) — format reference
-->
