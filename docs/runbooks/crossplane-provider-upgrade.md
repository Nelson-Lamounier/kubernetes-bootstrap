---
title: Crossplane Provider Upgrade
type: runbook
tags: [crossplane, providers, upgrade, argocd, gitops, kubernetes, s3, sqs]
sources:
  - charts/crossplane-providers/manifests/providers.yaml
  - argocd-apps/crossplane-providers.yaml
  - argocd-apps/crossplane.yaml
created: 2026-04-28
updated: 2026-04-28
---

# Crossplane Provider Upgrade

Step-by-step procedure for upgrading `provider-aws-s3` or `provider-aws-sqs` — why provider upgrades are decoupled from Crossplane core upgrades, how to verify the new provider version is healthy before ArgoCD reconciles managed resources, and what to watch for when a provider version introduces CRD schema changes.

## When to use this runbook

- Bumping `provider-aws-s3` or `provider-aws-sqs` to a new minor or patch version
- Responding to a CVE in a provider OCI package
- Upgrading Crossplane core (v1.18.x → v1.19.x) which may require co-ordinated provider upgrades

This runbook does NOT cover upgrades that change the XRD API version (e.g. `v1alpha1` → `v1beta1`) — those require a separate claim migration procedure.

## Architecture: why providers upgrade independently of core

The Crossplane core chart ([`argocd-apps/crossplane.yaml`](../../argocd-apps/crossplane.yaml), wave 4) and the providers ([`argocd-apps/crossplane-providers.yaml`](../../argocd-apps/crossplane-providers.yaml), wave 5) are separate ArgoCD Applications. The comment in `crossplane-providers.yaml` documents the design intent:

```yaml
# Provider lifecycle decoupled from core upgrades.
# Providers can be updated independently of the Crossplane core chart.
```

The consequence is that bumping `provider-aws-s3:v1.18.0` → `v1.18.1` requires touching only `charts/crossplane-providers/manifests/providers.yaml`. ArgoCD syncs wave 5 without re-applying the wave 4 core chart — no Crossplane controller restart, no CRD re-install.

## Pre-upgrade checklist

Before changing the version pin:

1. **Check the provider changelog** at `https://github.com/upbound/provider-aws/releases` for the target version. Look for:
   - CRD schema changes to `s3.aws.upbound.io` or `sqs.aws.upbound.io` resources
   - Deprecations of API versions currently in use (`v1beta1`, `v1beta2`)
   - Minimum Crossplane version requirements

2. **Verify current provider health:**
   ```bash
   kubectl get providers -o wide
   ```
   Expected output shows `INSTALLED: True`, `HEALTHY: True` for both providers. Do not upgrade an already-unhealthy provider.

3. **Check managed resource status:**
   ```bash
   kubectl get managed -o wide
   ```
   Any managed resources showing `SYNCED: False` or `READY: False` should be investigated before upgrading — the upgrade will restart provider pods, which interrupts reconciliation.

## Upgrade procedure

### Step 1 — Update the version pin

Edit [`charts/crossplane-providers/manifests/providers.yaml`](../../charts/crossplane-providers/manifests/providers.yaml). Both providers are in the same file:

```yaml
# provider-aws-s3
spec:
  package: xpkg.upbound.io/upbound/provider-aws-s3:v1.18.0  # change this

# provider-aws-sqs
spec:
  package: xpkg.upbound.io/upbound/provider-aws-sqs:v1.18.0  # change this
```

Providers can be upgraded independently — it is valid to bump only `provider-aws-s3` and leave `provider-aws-sqs` at the current version.

### Step 2 — Commit and push

ArgoCD syncs `crossplane-providers` on a 3-minute poll interval. After the commit reaches the `develop` branch, ArgoCD will detect the change and apply the updated `Provider` manifests.

### Step 3 — Monitor provider pod restart

When ArgoCD applies the updated `Provider` object, the Crossplane package manager pulls the new OCI package and restarts the provider pod. Watch for:

```bash
kubectl get pods -n crossplane-system -w
```

The provider pod goes through: `Terminating` → (new pod) `ContainerCreating` → `Running`. The pod name changes (includes a hash suffix from the new image digest).

Expected timeline: 60–120 seconds from pod termination to `Running`, depending on OCI pull time from `xpkg.upbound.io`.

### Step 4 — Verify CRD registration

After the provider pod is `Running`, confirm the provider has registered its CRDs:

```bash
kubectl get providers -o wide
# Wait for HEALTHY: True

kubectl get crds | grep s3.aws.upbound.io   # for provider-aws-s3
kubectl get crds | grep sqs.aws.upbound.io  # for provider-aws-sqs
```

If the provider stays `INSTALLED: True` but `HEALTHY: False` for more than 3 minutes, inspect the provider pod logs:

```bash
kubectl logs -n crossplane-system \
  -l pkg.crossplane.io/revision=provider-aws-s3 \
  --tail=50
```

### Step 5 — Verify managed resource reconciliation

After provider health is confirmed, verify existing managed resources are reconciling against AWS:

```bash
kubectl get managed -o wide
```

All resources should return to `SYNCED: True`, `READY: True` within 5 minutes of the provider becoming healthy. Crossplane queues all managed resources for re-reconciliation when a provider restarts.

If a managed resource is stuck at `SYNCED: False` after 5 minutes, describe it to see the error:

```bash
kubectl describe bucket.s3.aws.upbound.io crossplane-shared-<name>
# or
kubectl describe queue.sqs.aws.upbound.io crossplane-shared-<name>
```

## Crossplane core upgrade (wave 4)

Upgrading the Crossplane core chart is a separate procedure from provider upgrades. The core version is pinned in [`argocd-apps/crossplane.yaml`](../../argocd-apps/crossplane.yaml). Core upgrades may require:

1. Checking for `DeploymentRuntimeConfig` API version changes — currently `v1beta1` in [`providers.yaml`](../../charts/crossplane-providers/manifests/providers.yaml)
2. Checking for `ControllerConfig` removal — the old v1alpha1 API is deprecated since Crossplane 1.14 and will be removed in a future version
3. Verifying `ApplyOutOfSyncOnly=true` and `ServerSideApply=true` sync options remain compatible with the new core version

After a core upgrade, re-verify all three waves: wave 4 core health → wave 5 provider health → wave 6 XRD registration.

## Resource limits reference

Current resource allocation per provider pod ([`charts/crossplane-providers/manifests/providers.yaml`](../../charts/crossplane-providers/manifests/providers.yaml)):

| | CPU | Memory |
|---|---|---|
| Request | 25m | 64Mi |
| Limit | 100m | 128Mi |

Both providers share the `crossplane-provider-config` `DeploymentRuntimeConfig` and run on the `monitoring` node pool. If a provider upgrade increases memory requirements past 128Mi, update the limits in `DeploymentRuntimeConfig` alongside the version bump.

## Related

- [Crossplane AWS resource integration](../concepts/crossplane-aws-resources.md) — three-wave deployment chain, SkipDryRun pattern, credential bootstrap
- [Crossplane XRD golden paths](../concepts/crossplane-xrd-golden-paths.md) — developer claim syntax, what changes when XRD schema evolves
- [ArgoCD GitOps architecture](../concepts/argocd-gitops-architecture.md) — sync wave ordering that governs the upgrade sequence

<!--
Evidence trail (auto-generated):
- Source: charts/crossplane-providers/manifests/providers.yaml (read 2026-04-28 — provider-aws-s3:v1.18.0, provider-aws-sqs:v1.18.0, DeploymentRuntimeConfig requests 25m/64Mi limits 100m/128Mi, runtimeConfigRef, monitoring node pool)
- Source: argocd-apps/crossplane-providers.yaml (read 2026-04-28 — wave 5, retryCount 5, "Provider lifecycle decoupled" comment, manifests path)
- Source: argocd-apps/crossplane.yaml (read 2026-04-28 — wave 4, ApplyOutOfSyncOnly, ServerSideApply, retryCount 3)
- Generated: 2026-04-28
-->
