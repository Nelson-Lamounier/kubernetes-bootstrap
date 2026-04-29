---
title: Crossplane Resource Stuck Deleting
type: troubleshooting
tags: [crossplane, kubernetes, finalizers, s3, sqs, debugging, managed-resources]
sources:
  - charts/crossplane-xrds/chart/templates/x-encrypted-bucket.yaml
  - charts/crossplane-xrds/chart/templates/x-monitored-queue.yaml
  - charts/crossplane-providers/manifests/provider-config.yaml
created: 2026-04-28
updated: 2026-04-28
---

# Crossplane Resource Stuck Deleting

Diagnosis and resolution for Crossplane managed resources (S3 buckets, SQS queues) that remain in `Terminating` state after the claim or composite resource is deleted — covering the finalizer lifecycle, the provider-is-gone scenario, orphaned managed resources after claim deletion, and composite resource ownership cleanup.

## How Crossplane deletion works

When a developer deletes a claim (`EncryptedBucket` or `MonitoredQueue`), Crossplane's delete cascade is:

```
kubectl delete encryptedbucket my-assets     # developer action
→ Composite Resource (XEncryptedBucket) deletion triggered
  → All managed resources in the Composition get deletion timestamps
    → Provider pod calls AWS DeleteBucket / DeleteQueue
      → AWS confirms deletion
        → Provider removes finalizer from managed resource
          → Managed resource object is garbage collected
            → Composite Resource finalizer removed
              → Claim fully deleted
```

The finalizer on each managed resource (`finalizer.managedresource.crossplane.io`) is what keeps the Kubernetes object alive until the AWS resource is confirmed deleted. The provider pod must be running and healthy to perform step 4 (AWS delete) and step 5 (finalizer removal).

## Scenario 1: Provider pod not running

**Symptom:** Managed resources show `DeletionTimestamp` set but stay in the cluster indefinitely. `kubectl get managed -o wide` shows `SYNCED: Unknown` or blank.

**Cause:** The provider pod is not running, so no controller exists to call the AWS delete API and remove the finalizer.

**Diagnosis:**

```bash
# Check provider health
kubectl get providers -o wide

# Check if provider pod exists
kubectl get pods -n crossplane-system -l pkg.crossplane.io/revision=provider-aws-s3

# Check specific stuck managed resource
kubectl describe bucket.s3.aws.upbound.io crossplane-shared-<name>
# Look for: Conditions, last reconcile timestamp
```

**Resolution:** Restore the provider pod to a running state (see [provider upgrade runbook](../runbooks/crossplane-provider-upgrade.md) for health verification steps). Once the provider is healthy, it will process the pending deletion queue automatically — no manual intervention needed.

If the provider cannot be restored (e.g. credential issue) and you need to force-delete the Kubernetes object while leaving the AWS resource in place, see Scenario 3 below.

## Scenario 2: AWS resource already deleted manually

**Symptom:** Managed resource is stuck in `Terminating`. Crossplane provider logs show `404 NoSuchBucket` or `AWS.SimpleQueueService.NonExistentQueue`.

**Cause:** The S3 bucket or SQS queue was deleted directly in AWS (via console or CLI) before Crossplane processed the deletion. The provider attempts to delete the resource, gets a 404, and may retry indefinitely depending on its error handling policy.

**Diagnosis:**

```bash
kubectl describe bucket.s3.aws.upbound.io crossplane-shared-<name>
# Look for: Message: "404 Not Found" or similar AWS error in Conditions
```

**Resolution:** Once you confirm the AWS resource no longer exists, you can safely remove the finalizer to unblock Kubernetes garbage collection:

```bash
kubectl patch bucket.s3.aws.upbound.io crossplane-shared-<name> \
  --type merge \
  -p '{"metadata":{"finalizers":[]}}'
```

For SQS queues:

```bash
kubectl patch queue.sqs.aws.upbound.io crossplane-shared-<name> \
  --type merge \
  -p '{"metadata":{"finalizers":[]}}'
```

After the finalizer is removed, Kubernetes immediately garbage collects the managed resource object. The Composite Resource then detects all managed resources are gone and removes its own finalizer.

## Scenario 3: Force-delete Kubernetes object, preserve AWS resource

Use this only when you want to remove the Crossplane-managed object from Kubernetes without deleting the underlying AWS resource — for example, when migrating a resource out of Crossplane management.

**Step 1:** Set `deletionPolicy: Orphan` on the managed resource to tell the provider not to delete the AWS resource:

```bash
kubectl patch bucket.s3.aws.upbound.io crossplane-shared-<name> \
  --type merge \
  -p '{"spec":{"deletionPolicy":"Orphan"}}'
```

**Step 2:** Remove the finalizer:

```bash
kubectl patch bucket.s3.aws.upbound.io crossplane-shared-<name> \
  --type merge \
  -p '{"metadata":{"finalizers":[]}}'
```

The AWS resource remains. The Kubernetes object is garbage collected. The bucket or queue is now unmanaged — Crossplane will not reconcile it.

## Scenario 4: Composite resource stuck after managed resources are gone

**Symptom:** All managed resources are deleted (`kubectl get managed` returns nothing for this claim), but the `XEncryptedBucket` or `XMonitoredQueue` composite resource is still in `Terminating`.

**Cause:** The Composite Resource has its own finalizer (`finalizer.apiextensions.crossplane.io`) managed by the Composition engine. The engine normally removes this once all composed resources are gone. If the Crossplane core pod restarted or had an error during the deletion cascade, the finalizer may not have been cleaned up.

**Diagnosis:**

```bash
kubectl get xencryptedbuckets -o wide
kubectl describe xencryptedbucket <name>
# Look for: finalizers in metadata, Conditions
```

**Resolution:** If the Composite Resource has no composed resources remaining (all managed resources are gone) and is stuck, patch out its finalizer:

```bash
kubectl patch xencryptedbucket <name> \
  --type merge \
  -p '{"metadata":{"finalizers":[]}}'
```

For `XMonitoredQueue`:

```bash
kubectl patch xmonitoredqueue <name> \
  --type merge \
  -p '{"metadata":{"finalizers":[]}}'
```

After the Composite Resource is gone, check whether the claim is also unblocked:

```bash
kubectl get encryptedbuckets -A
kubectl get monitoredqueues -A
```

Claims have their own finalizer (`finalizer.apiextensions.crossplane.io`) and should self-clear once the Composite Resource is deleted.

## Managed resource types in this cluster

The resource group and kind names to use in `kubectl` commands:

| XRD | Managed resource type | kubectl resource name |
|-----|----------------------|----------------------|
| XEncryptedBucket | `s3.aws.upbound.io/v1beta2 Bucket` | `bucket.s3.aws.upbound.io` |
| XEncryptedBucket | `s3.aws.upbound.io/v1beta1 BucketVersioning` | `bucketversioning.s3.aws.upbound.io` |
| XEncryptedBucket | `s3.aws.upbound.io/v1beta1 BucketServerSideEncryptionConfiguration` | `bucketserversideencryptionconfiguration.s3.aws.upbound.io` |
| XEncryptedBucket | `s3.aws.upbound.io/v1beta1 BucketPublicAccessBlock` | `bucketpublicaccessblock.s3.aws.upbound.io` |
| XEncryptedBucket | `s3.aws.upbound.io/v1beta1 BucketLifecycleConfiguration` | `bucketlifecycleconfiguration.s3.aws.upbound.io` |
| XMonitoredQueue | `sqs.aws.upbound.io/v1beta2 Queue` (DLQ) | `queue.sqs.aws.upbound.io` |
| XMonitoredQueue | `sqs.aws.upbound.io/v1beta2 Queue` (main) | `queue.sqs.aws.upbound.io` |

`kubectl get managed` returns all managed resources across all provider CRDs — use it for a global view.

## Sub-resource ordering for XEncryptedBucket deletion

Deleting an `EncryptedBucket` claim triggers deletion of 5 managed resources. AWS requires specific ordering: sub-resources (`BucketVersioning`, `BucketLifecycleConfiguration`, `BucketServerSideEncryptionConfiguration`, `BucketPublicAccessBlock`) must be deleted before the `Bucket` itself can be deleted. Crossplane handles this automatically via resource ownership labels — sub-resources reference the parent bucket via `spec.forProvider.bucketSelector.matchLabels[crossplane.io/claim-name]` ([`x-encrypted-bucket.yaml`](../../charts/crossplane-xrds/chart/templates/x-encrypted-bucket.yaml)), and the provider respects this dependency ordering.

If you manually remove the finalizer from the `Bucket` resource while sub-resources still exist, the S3 bucket may be re-created by the sub-resource reconciler trying to reach its desired state. Remove finalizers in reverse order: sub-resources first, bucket last.

## Related

- [Crossplane AWS resource integration](../concepts/crossplane-aws-resources.md) — three-wave deployment chain, SkipDryRun pattern, provider credential bootstrap
- [Crossplane XRD golden paths](../concepts/crossplane-xrd-golden-paths.md) — claim syntax, full resource inventory per XRD
- [Crossplane provider upgrade](../runbooks/crossplane-provider-upgrade.md) — how to restore a provider to healthy state

<!--
Evidence trail (auto-generated):
- Source: charts/crossplane-xrds/chart/templates/x-encrypted-bucket.yaml (read 2026-04-28 — 5 managed resource types, bucketSelector.matchLabels[crossplane.io/claim-name] cross-resource references, s3.aws.upbound.io/v1beta1 and v1beta2 API versions)
- Source: charts/crossplane-xrds/chart/templates/x-monitored-queue.yaml (read 2026-04-28 — 2 managed resource types, sqs.aws.upbound.io/v1beta2, queue-role: dlq label)
- Source: charts/crossplane-providers/manifests/provider-config.yaml (read 2026-04-28 — SkipDryRun annotation, provider namespace crossplane-system)
- Generated: 2026-04-28
-->
