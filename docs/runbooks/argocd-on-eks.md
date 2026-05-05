# Runbook — Install ArgoCD on the EKS Cluster

**When to run:** Once, after `Deploy EKS to Development` workflow reports
success and `kubectl get nodes` shows 3 system nodes Ready.

**Why:** ArgoCD is the entry point for everything else. We install it
manually one time so subsequent changes are git-driven via the root app
created in `argocd-apps/eks/root-app-development.yaml`.

**Why not via `EksAddonsStack`?** Mixing ArgoCD with the CDK-managed Helm
charts in the addons stack creates a chicken-and-egg: ArgoCD would need
to exist before it can reconcile its own configuration. Cleaner to
install once via Helm CLI and hand off to git.

## Prerequisites

- AWS CLI configured with the dev account.
- `kubectl` and `helm` installed.
- EKS cluster `k8s-eks-development` exists and is ACTIVE.
- An EKS Access Entry exists for your IAM principal with the
  `AmazonEKSClusterAdminPolicy` access policy attached.

## Steps

### 1. Configure kubectl

```bash
aws eks update-kubeconfig \
  --name k8s-eks-development \
  --region eu-west-1 \
  --alias eks-dev
kubectl --context eks-dev get nodes
# Expected: 3 t3.medium nodes, taint dedicated=system:NoSchedule
```

### 2. Install ArgoCD via Helm

```bash
helm repo add argo https://argoproj.github.io/argo-helm
helm repo update
helm upgrade --install argocd argo/argo-cd \
  --namespace argocd \
  --create-namespace \
  --version 7.7.5 \
  --set 'server.service.type=ClusterIP' \
  --set 'configs.params."server.insecure"=true' \
  --set 'controller.tolerations[0].key=dedicated' \
  --set 'controller.tolerations[0].value=system' \
  --set 'controller.tolerations[0].effect=NoSchedule' \
  --set 'repoServer.tolerations[0].key=dedicated' \
  --set 'repoServer.tolerations[0].value=system' \
  --set 'repoServer.tolerations[0].effect=NoSchedule' \
  --set 'server.tolerations[0].key=dedicated' \
  --set 'server.tolerations[0].value=system' \
  --set 'server.tolerations[0].effect=NoSchedule' \
  --set 'redis.tolerations[0].key=dedicated' \
  --set 'redis.tolerations[0].value=system' \
  --set 'redis.tolerations[0].effect=NoSchedule' \
  --set 'applicationSet.tolerations[0].key=dedicated' \
  --set 'applicationSet.tolerations[0].value=system' \
  --set 'applicationSet.tolerations[0].effect=NoSchedule' \
  --set 'notifications.tolerations[0].key=dedicated' \
  --set 'notifications.tolerations[0].value=system' \
  --set 'notifications.tolerations[0].effect=NoSchedule' \
  --kube-context eks-dev
```

The system MNG taint forces ArgoCD's components onto the system nodes
(where the SQS-receiving Karpenter controller also runs); workload pods
land on Karpenter-provisioned nodes once Plan 5 begins.

### 3. Wait for ArgoCD to be Ready

```bash
kubectl --context eks-dev -n argocd wait \
  --for=condition=available deployment --all --timeout=5m
```

### 4. Add the SSH deploy key (read-only)

The root app's `source.repoURL` is SSH. ArgoCD needs a private key to
clone the repo:

```bash
DEPLOY_KEY=$(aws ssm get-parameter \
  --name /shared/development/argocd-deploy-key \
  --with-decryption --query 'Parameter.Value' --output text)

kubectl --context eks-dev -n argocd create secret generic argocd-repo-creds \
  --from-literal=type=git \
  --from-literal=url=git@github.com:Nelson-Lamounier/kubernetes-bootstrap.git \
  --from-literal=sshPrivateKey="$DEPLOY_KEY"
kubectl --context eks-dev -n argocd label secret argocd-repo-creds \
  argocd.argoproj.io/secret-type=repository
```

### 5. Apply the root app

```bash
kubectl --context eks-dev apply \
  -f https://raw.githubusercontent.com/Nelson-Lamounier/kubernetes-bootstrap/main/argocd-apps/eks/root-app-development.yaml
```

### 6. Verify

```bash
kubectl --context eks-dev -n argocd get application eks-root-development
# Expected: SYNC STATUS=Synced, HEALTH STATUS=Healthy
```

The app reconciles an empty directory, so `Synced` + `Healthy` is the
target state for V1. Plan 5 fills the directory and watches individual
workload Apps appear.

## Troubleshooting

- **OutOfSync, "directory is empty":** the root app is missing
  `syncPolicy.automated.allowEmpty: true`. Re-apply the manifest from
  the latest main.
- **ComparisonError, "repository not accessible":** the deploy-key
  secret is missing the `argocd.argoproj.io/secret-type=repository`
  label. ArgoCD ignores secrets without it.
- **Application controller pod Pending:** the system MNG isn't tolerated
  in the Helm values above — re-run step 2 with the toleration flags
  for every component.

## Spec

`cdk-monitoring/docs/superpowers/specs/2026-05-05-eks-migration-design.md` §§ 3.3, 7.3.
