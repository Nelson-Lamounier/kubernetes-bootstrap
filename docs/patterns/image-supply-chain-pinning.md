---
title: Image supply-chain pinning — digests for CI runners, sha-regex for apps
type: pattern
tags: [security, supply-chain, container-images, argocd-image-updater, ecr, ghcr, ci-cd, reproducibility]
sources:
  - argocd-apps/eks/development/arc-runners-tucaken.yaml
  - argocd-apps/eks/development/arc-runners-cdk-monitoring.yaml
  - argocd-apps/eks/development/admin-api.yaml
created: 2026-07-05
updated: 2026-07-05
---

# Image supply-chain pinning — digests for CI runners, sha-regex for apps

## Intent

Prevent mutable image tags from silently changing what runs in the cluster.
Two variants are applied depending on how the image is delivered: **digest
pins** for images that must never move, and **immutable-tag constraints via
ArgoCD Image Updater** for application images that should auto-update but only
to verifiable build tags. Introduced in PR
[#213](https://github.com/Nelson-Lamounier/kubernetes-bootstrap/pull/213).

## When to apply

Apply pinning to any image referenced by a mutable tag (`:latest`, a branch
name, or a tag an external party can overwrite). The threat is tag poisoning:
whoever can push to the registry replaces the running container without any
Git-visible change. The risk is highest for images that hold privilege — most
sharply the CI runner image, which executes workflow code and holds the runner's
cluster RBAC.

## Variant 1 — digest pin for CI runner images

The self-hosted runner images are pinned by digest, so any change to the image
is a Git-visible diff and a poisoned tag cannot swap the running runner
([argocd-apps/eks/development/arc-runners-tucaken.yaml](../../argocd-apps/eks/development/arc-runners-tucaken.yaml)):

```yaml
image: ghcr.io/nelson-lamounier/cdk-monitoring/arc-runner@sha256:d768c1ccafcc…
```

Bumping the runner image is then a deliberate edit that updates the digest, not
an implicit pull. This closes the tag-poisoning path into the runner RBAC that
the [ARC RBAC scoping decision](../decisions/arc-runner-rbac-namespace-scoping.md)
narrows.

## Variant 2 — sha-regex constraint via ArgoCD Image Updater

Application images that should track new builds are auto-updated by ArgoCD Image
Updater, but constrained to an immutable build-tag pattern so the updater only
promotes verifiable commit-sha tags, never a floating `:latest`
([argocd-apps/eks/development/admin-api.yaml](../../argocd-apps/eks/development/admin-api.yaml)):

```yaml
argocd-image-updater.argoproj.io/<image>.allow-tags: regexp:^[0-9a-f]{7,40}(-r[0-9]+)?$
argocd-image-updater.argoproj.io/<image>.update-strategy: newest-build
```

The updater writes the resolved tag back to Git, so the running version is
always recorded in a commit. This is documented further in
[ArgoCD Image Updater](../concepts/argocd-image-updater.md).

## A related trap: broken fallback tags

The same PR fixed chart fallback values pointing at `:latest` tags that did not
exist in their ECR repositories (`synthetic-monitor`, `ontology-importer`) — the
fallback could never pull. Pinning them to the newest immutable tag makes a
clean install deploy successfully. The lesson: a mutable tag is not just a
security risk, it can be a silent availability bug when the tag is absent.

## Related

- [ArgoCD Image Updater](../concepts/argocd-image-updater.md)
- [GitOps security-hardening sweep](../projects/2026-07-security-hardening-sweep.md)

<!--
Evidence trail (auto-generated):
- Source: argocd-apps/eks/development/arc-runners-tucaken.yaml (digest pin, read 2026-07-05)
- Source: argocd-apps/eks/development/admin-api.yaml (image-updater sha-regex, read 2026-07-05)
- Git: origin/main PR #213 (1be9623)
-->
