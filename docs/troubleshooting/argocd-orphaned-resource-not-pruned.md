---
title: ArgoCD does not prune orphaned resources that lack a tracking-id annotation
type: troubleshooting
tags: [argocd, gitops, kubernetes, prune, resource-tracking, migration, rbac]
sources:
  - gitops/arc/runner-rbac.yaml
  - charts/headlamp-config/chart/templates/admin.yaml
created: 2026-07-05
updated: 2026-07-05
---

# ArgoCD does not prune orphaned resources that lack a tracking-id annotation

## Symptom

You remove a resource from a chart or rename it, the owning ArgoCD Application
syncs green, but the **old object stays live** in the cluster. Examples seen on
this cluster: after scoping the ARC runner RBAC a cluster-wide `arc-runner`
ClusterRole + ClusterRoleBinding persisted; after removing the Headlamp admin
token the `headlamp-admin-token` Secret persisted; after the Traefik retire the
`arc-webhook-ingress` IngressRoute persisted. Each was inert but, for the RBAC
and token cases, still a live security grant.

## Root cause: annotation tracking vs a label-only resource

ArgoCD is configured with `application.resourceTrackingMethod: annotation`, so
it decides ownership by the `argocd.argoproj.io/tracking-id` **annotation** on
each live object. Resources created during the earlier kubeadm era carry only
the legacy `argocd.argoproj.io/instance` **label** and have no tracking-id
annotation. ArgoCD therefore does not consider them part of any Application, so
they never appear in the Application's `status.resources` and are never selected
for pruning — even though the Git manifest that once defined them is gone.

Confirm the cause on a stuck object:

```bash
kubectl get clusterrole arc-runner \
  -o jsonpath='tracking=[{.metadata.annotations.argocd\.argoproj\.io/tracking-id}] label=[{.metadata.labels.argocd\.argoproj\.io/instance}]{"\n"}'
# tracking=[] label=[arc-config]   <-- label present, annotation empty = orphan
```

An empty `tracking=[]` with a non-empty `label=[]` is the signature. Contrast a
healthy resource, which shows a populated `tracking-id` and appears in the
Application's resource tree with `requiresPruning` when its manifest is removed.

## Diagnosis

1. Confirm the Application actually synced the commit that removed the manifest
   (`kubectl -n argocd get application <app> -o jsonpath='{.status.sync.revision}'`).
2. Check whether the stray object is in the Application's tracked set:
   ```bash
   kubectl -n argocd get application <app> -o json \
     | jq '.status.resources[] | select(.name=="<object>")'
   ```
   No result means ArgoCD does not track it → it will not be pruned.
3. Inspect the object's tracking-id annotation as shown above.

## Fix

For a genuinely orphaned object (Git no longer declares it, ArgoCD cannot see
it), delete it directly to complete convergence — this makes the live state
match Git, which is the GitOps intent, not a drift from it:

```bash
kubectl delete clusterrole arc-runner
kubectl delete clusterrolebinding arc-runner
```

Re-verify the effect of the change afterwards. For the RBAC case the check is
the impersonation test:

```bash
kubectl auth can-i get secrets \
  --as=system:serviceaccount:arc-runners:arc-runner -n monitoring
# no
```

Some ESO-owned Secrets cascade-delete once their `ExternalSecret` is pruned;
others linger and need the same manual delete.

## Prevention

- When a resource is ArgoCD-managed but predates annotation tracking, re-adopt
  it (let ArgoCD apply the tracking-id) before removing its manifest, so the
  next sync prunes it normally.
- Treat a rename as delete-plus-create: the old name is an orphan candidate.
- After any manifest removal, verify the live object is gone rather than
  trusting a green sync.

## Related

- [GitOps security-hardening sweep](../projects/2026-07-security-hardening-sweep.md)
  — where this pattern recurred across RBAC, tokens, and IngressRoutes
- [ArgoCD stale manifest cache](../runbooks/argocd-stale-manifest-cache.md)

<!--
Evidence trail (auto-generated):
- Source: gitops/arc/runner-rbac.yaml (rename that orphaned the ClusterRole, 2026-07-05)
- Live: kubectl get clusterrole arc-runner -o jsonpath tracking/label (2026-07-05)
- Live: kubectl -n argocd get cm argocd-cm resourceTrackingMethod=annotation (2026-07-05)
- Git: origin/main PRs #202, #203, #222
-->
