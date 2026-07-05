---
title: Manifest validation gate — helm template + kubeconform
type: tool
tags: [ci-cd, gitops, argocd, helm, kubeconform, github-actions, validation, shift-left]
sources:
  - scripts/validate-manifests.py
  - .github/workflows/validate-manifests.yml
created: 2026-07-05
updated: 2026-07-05
---

# Manifest validation gate — helm template + kubeconform

A pull-request CI gate that renders and schema-validates the entire GitOps
deployment surface before merge, so a broken chart or manifest fails the PR
instead of failing at ArgoCD sync time. Added in PR
[#205](https://github.com/Nelson-Lamounier/kubernetes-bootstrap/pull/205)
([scripts/validate-manifests.py](../../scripts/validate-manifests.py),
[.github/workflows/validate-manifests.yml](../../.github/workflows/validate-manifests.yml)).

## What it validates

The script runs three passes that mirror what ArgoCD does at sync time:

1. **`helm lint`** on all local charts under `charts/*/chart`.
2. **Render + kubeconform.** For each synced Application under
   `argocd-apps/eks/`, it re-renders every in-repo Helm source with the *exact*
   `valueFiles` / `values` / `valuesObject` the Application declares, then
   schema-checks the rendered output with `kubeconform -strict`. Raw-manifest
   directory sources (for example `gitops/arc`) are checked in place.
3. **Application schema.** Every `Application`/`ApplicationSet` document under
   `argocd-apps/` is schema-validated.

Rendering each Application with its declared value files is the key detail: it
catches errors that only appear under the real environment overlay, not just
the chart defaults.

## Schema sources

`kubeconform` is configured with the default Kubernetes schemas plus the
community CRD catalog, so custom kinds (`Application`, `ExternalSecret`,
`IngressRoute`, `Rollout`) are validated rather than skipped
([scripts/validate-manifests.py](../../scripts/validate-manifests.py)).
`-ignore-missing-schemas` keeps niche CRDs from blocking the gate while
everything with a published schema is still checked strictly.

## The workflow trigger

The GitHub Actions workflow runs on pull requests touching `charts/**`,
`argocd-apps/**`, `gitops/**`, or the script itself. It installs Helm and a
pinned kubeconform, then runs the script; a non-zero exit fails the check
([.github/workflows/validate-manifests.yml](../../.github/workflows/validate-manifests.yml)).
The workflow interpolates no event-controlled input into shell, so it has no
injection surface.

## Defects it caught on first run

The gate paid for itself immediately: on its first local run it flagged a
missing YAML document separator in `charts/platform-rds/chart/templates/
ddl-migrations.yaml` (two migration Jobs rendered as one document with duplicate
`apiVersion`/`kind` keys) and schema-invalid Compositions in a dead
`crossplane-xrds` chart. Both were real problems that would otherwise have
surfaced only at sync time.

## Running it locally

```bash
python3 scripts/validate-manifests.py
# ✓ helm lint: 17 charts clean
# ✓ render + kubeconform: 41 in-repo sources validated
# ✓ Application schema: 51 Application/ApplicationSet docs valid
```

Requires `helm`, `kubeconform`, and PyYAML on the path.

## Related

- [ArgoCD GitOps architecture](../concepts/argocd-gitops-architecture.md)
- [Deployment pipeline order](../concepts/deployment-pipeline-order.md)

<!--
Evidence trail (auto-generated):
- Source: scripts/validate-manifests.py (read 2026-07-05)
- Source: .github/workflows/validate-manifests.yml (read 2026-07-05)
- Git: origin/main PR #205 (0be4ef5)
-->
