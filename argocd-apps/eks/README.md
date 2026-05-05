# ArgoCD Apps — EKS Cluster Tree

This subtree is reconciled by the ArgoCD instance running on the **EKS**
cluster (`k8s-eks-development` and equivalents in staging / production).
The existing top-level `argocd-apps/*.yaml` tree is reconciled by the
**kubeadm** cluster's ArgoCD and is not touched by EKS.

## Layout

- `root-app-<env>.yaml` — single `Application` whose source path is
  `argocd-apps/eks/<env>/`. Apply once after ArgoCD is installed on the
  EKS cluster (see `docs/runbooks/argocd-on-eks.md`); everything else
  reconciles from git.
- `<env>/` — flat list of `Application` manifests. Empty in V1
  (Plan 4). Plan 5 (workload cutover) fills this directory.

## Why a separate tree

The kubeadm and EKS clusters run different chart versions and different
infra addons (kubeadm uses Cluster Autoscaler; EKS uses Karpenter
installed via CDK Helm in `EksAddonsStack`). Having one tree per cluster
keeps reconciliation deterministic — no conditional logic in Helm values
based on cluster identity.

## Spec

`cdk-monitoring/docs/superpowers/specs/2026-05-05-eks-migration-design.md` § 7.3.
