---
title: CloudFront Connectivity Troubleshooting
type: troubleshooting
tags: [cloudfront, traefik, networking, kubernetes, calico, aws, elastic-ip]
sources:
  - charts/traefik/traefik-values.yaml
  - argocd-apps/traefik.yaml
created: 2026-04-28
updated: 2026-04-28
---

# CloudFront → Kubernetes Connectivity Troubleshooting Guide

A step-by-step guide for diagnosing and resolving connectivity failures between CloudFront and the Next.js application running on a kubeadm Kubernetes cluster. All commands are run from the **control-plane node** (via SSM) or from your **local machine** (via AWS CLI).

---

## Table of Contents

- [Architecture Overview](#architecture-overview)
- [Quick Health Check](#quick-health-check)
- [Step 1 — Verify DNS Resolution](#step-1--verify-dns-resolution)
- [Step 2 — Verify CloudFront Distribution](#step-2--verify-cloudfront-distribution)
- [Step 3 — Verify the Elastic IP](#step-3--verify-the-elastic-ip)
- [Step 4 — Verify Traefik Ingress](#step-4--verify-traefik-ingress)
- [Step 5 — Verify IngressRoute and Service](#step-5--verify-ingressroute-and-service)
- [Step 6 — Verify Pod Health](#step-6--verify-pod-health)
- [Step 7 — Verify Cross-Node Pod Networking (Calico)](#step-7--verify-cross-node-pod-networking-calico)
- [Step 8 — Verify Security Group and NACLs](#step-8--verify-security-group-and-nacls)
- [Common Fixes Reference](#common-fixes-reference)
- [Glossary](#glossary)

---

## Architecture Overview

```text
User Browser
  │
  ▼
DNS (nelsonlamounier.com)
  │  Route 53 alias → CloudFront distribution
  ▼
CloudFront (us-east-1)
  │  HTTPS termination (ACM certificate)
  │  WAF Web ACL inspection
  │  Forwards HTTP to origin
  ▼
Elastic IP (eu-west-1)
  │  Static public IP associated with a K8s node
  ▼
Traefik (DaemonSet, hostNetwork: true)
  │  Listens on port 80 (web) and 443 (websecure)
  │  Routes via IngressRoute CRDs
  ▼
IngressRoute (PathPrefix('/'))
  │  Matches all paths to nextjs service
  ▼
ClusterIP Service (nextjs:3000)
  │  Kubernetes service → pod endpoints
  ▼
Next.js Pod (nextjs-app namespace)
     Port 3000, health: /api/health
```

**Key Design Decisions:**

| Decision | Rationale |
|---|---|
| TLS terminated at CloudFront | Traefik's self-signed cert doesn't match our domain |
| CloudFront → EIP uses `HTTP_ONLY` | Avoids SSL hostname mismatch errors |
| Traefik runs as DaemonSet with `hostNetwork` | Direct port binding on nodes, no LoadBalancer resource needed |
| Calico `CrossSubnet` VXLAN mode | Direct routing for same-subnet, VXLAN for cross-subnet |
| Source/dest check disabled on all nodes | Required for Calico direct routing with pod IPs |

---

## Quick Health Check

Run these commands from your **local machine** to quickly identify which layer is broken:

```bash
# 1. DNS → CloudFront (should return 200 or 301)
curl -s -o /dev/null -w "CloudFront: %{http_code}\n" \
  https://nelsonlamounier.com/api/health

# 2. Direct EIP bypass (should return 200)
EIP=$(aws ssm get-parameter \
  --name "/k8s/development/elastic-ip" \
  --query "Parameter.Value" --output text \
  --region eu-west-1 --profile dev-account)
curl -s -o /dev/null -w "EIP direct: %{http_code}\n" \
  http://$EIP/api/health

# 3. CloudFront origin (check what CF actually points to)
aws cloudfront list-distributions \
  --query "DistributionList.Items[].{Id:Id,Origin:Origins.Items[0].DomainName,Domain:Aliases.Items[0]}" \
  --output table --region us-east-1 --profile dev-account
```

**Interpretation:**

| CloudFront | EIP Direct | Problem Layer |
|---|---|---|
| 200 | 200 | ✅ Everything works |
| 504 | 200 | CloudFront origin stale or wrong IP |
| 504 | 504 | Traefik → Pod routing broken |
| 502 | 502 | Pod crashing or not listening |
| 403 | 200 | WAF blocking / IP restriction |
| DNS error | — | DNS not configured |

---

## Step 1 — Verify DNS Resolution

### What to check

The domain `nelsonlamounier.com` must resolve to the CloudFront distribution's domain name.

### Commands (local machine)

```bash
# Check what the domain resolves to
dig nelsonlamounier.com +short

# Check if it's a CNAME/alias to CloudFront
dig nelsonlamounier.com CNAME +short
nslookup nelsonlamounier.com
```

### Expected result

The domain should resolve to CloudFront IP addresses (varying IPs from CloudFront's edge network). If using a Route 53 alias record, `dig` may show the CloudFront IPs directly rather than a CNAME.

### Fix — DNS not resolving

If DNS doesn't resolve, the Route 53 alias record is missing. Check:

```bash
# Use the cross-account role to list records in the hosted zone
aws route53 list-resource-record-sets \
  --hosted-zone-id <HOSTED_ZONE_ID> \
  --query "ResourceRecordSets[?Name=='nelsonlamounier.com.']" \
  --output table --profile root-account
```

The edge stack's `DnsAliasRecord` custom resource creates this record. Redeploy the edge stack if missing.

---

## Step 2 — Verify CloudFront Distribution

### What to check

CloudFront must have the correct origin hostname pointing to the current Elastic IP.

### Commands (local machine)

```bash
# Get the distribution ID and current origin
aws cloudfront list-distributions \
  --query "DistributionList.Items[].{Id:Id,Origin:Origins.Items[].DomainName,Alias:Aliases.Items[0],Status:Status}" \
  --output table --region us-east-1 --profile dev-account

# Get detailed origin config (replace DISTRIBUTION_ID)
aws cloudfront get-distribution-config --id <DISTRIBUTION_ID> \
  --region us-east-1 --profile dev-account \
  | jq '.DistributionConfig.Origins.Items[] | select(.DomainName | contains("ec2-"))'
```

### Expected result

The EIP origin should be:
- **DomainName:** `ec2-<EIP-dashed>.eu-west-1.compute.amazonaws.com`
- **OriginProtocolPolicy:** `http-only`
- **HTTPPort:** `80`

### Fix — Stale CloudFront origin

If the origin hostname doesn't match the current EIP:

```bash
# 1. Check what the current EIP is
aws ssm get-parameter \
  --name "/k8s/development/elastic-ip" \
  --query "Parameter.Value" --output text \
  --region eu-west-1 --profile dev-account

# 2. Redeploy the edge stack (preferred — updates origin from SSM)
# Trigger the deploy-edge pipeline job, or:
npx cdk deploy KubernetesEdgeStack --region us-east-1 --profile dev-account

# 3. Emergency manual fix (if pipeline is unavailable)
# Export current config, update the origin hostname, re-apply:
aws cloudfront get-distribution-config --id <DIST_ID> \
  --region us-east-1 --profile dev-account > /tmp/cf-config.json

ETAG=$(jq -r '.ETag' /tmp/cf-config.json)

# Update the origin domain in the config
jq '.DistributionConfig.Origins.Items = [
  .DistributionConfig.Origins.Items[] |
  if .DomainName | contains("ec2-")
  then .DomainName = "ec2-<EIP-DASHED>.eu-west-1.compute.amazonaws.com"
  else . end
]' /tmp/cf-config.json > /tmp/cf-updated.json

jq '.DistributionConfig' /tmp/cf-updated.json > /tmp/cf-dist.json

aws cloudfront update-distribution \
  --id <DIST_ID> --if-match "$ETAG" \
  --distribution-config file:///tmp/cf-dist.json \
  --region us-east-1 --profile dev-account
```

> **Note:** CloudFront takes 2–5 minutes to propagate after an origin change.

---

## Step 3 — Verify the Elastic IP

### What to check

The EIP must exist, be associated with a running node, and match the SSM parameter.

### Commands (local machine)

```bash
# List all EIPs in the cluster
aws ec2 describe-addresses \
  --query "Addresses[].{IP:PublicIp,AllocationId:AllocationId,Instance:InstanceId,Name:Tags[?Key=='Name']|[0].Value}" \
  --output table --region eu-west-1 --profile dev-account

# Check the SSM parameter value
aws ssm get-parameter \
  --name "/k8s/development/elastic-ip" \
  --query "Parameter.Value" --output text \
  --region eu-west-1 --profile dev-account

# Direct test via EIP (should return 200)
curl -s -o /dev/null -w "%{http_code}" http://<EIP>/api/health
```

### Expected result

- EIP is listed with an associated `InstanceId` (not `None`)
- SSM parameter value matches the EIP IP address
- Direct curl returns `200`

### Fix — EIP unassociated

```bash
# Find the worker node instance ID (where Next.js pods run)
WORKER_ID=$(aws ec2 describe-instances \
  --filters "Name=private-ip-address,Values=<WORKER_PRIVATE_IP>" \
  --query "Reservations[0].Instances[0].InstanceId" --output text \
  --region eu-west-1 --profile dev-account)

# Associate the EIP
aws ec2 associate-address \
  --allocation-id <ALLOCATION_ID> \
  --instance-id $WORKER_ID \
  --allow-reassociation \
  --region eu-west-1 --profile dev-account
```

### Fix — SSM parameter stale

```bash
aws ssm put-parameter \
  --name "/k8s/development/elastic-ip" \
  --value "<CORRECT_EIP>" \
  --overwrite \
  --region eu-west-1 --profile dev-account
```

> **Important:** After updating SSM, redeploy the edge stack so CloudFront picks up the new EIP.

---

## Step 4 — Verify Traefik Ingress

### What to check

Traefik must be running on the node with the EIP and able to route traffic.

### Commands (control plane SSM session)

```bash
# Check Traefik pods (DaemonSet — should be one per node)
kubectl get pods -n kube-system -l app.kubernetes.io/name=traefik -o wide

# Check Traefik is listening on port 80
curl -s -o /dev/null -w "%{http_code}" http://localhost/api/health

# Check Traefik entry points
kubectl get svc -n kube-system -l app.kubernetes.io/name=traefik
```

### Expected result

- Traefik pod Running on every node
- `curl localhost` returns `200` (if the pod is on this node) or `504` (pod on another node)

### Fix — Traefik not running

```bash
# Check if ArgoCD has synced Traefik
kubectl get app traefik -n argocd -o jsonpath='{.status.health.status}'

# Force ArgoCD sync
argocd app sync traefik --force
```

---

## Step 5 — Verify IngressRoute and Service

### What to check

The Traefik IngressRoute must route `PathPrefix('/')` to the Next.js service.

### Commands (control plane SSM session)

```bash
# Check IngressRoute
kubectl get ingressroute -n nextjs-app -o yaml

# Verify the service has endpoints
kubectl get endpoints nextjs -n nextjs-app

# Check service details
kubectl get svc nextjs -n nextjs-app -o wide
```

### Expected result

- IngressRoute with `match: PathPrefix('/')` targeting service `nextjs` on port `3000`
- Service endpoints list at least one pod IP
- Service type is `ClusterIP`

### Fix — No endpoints

If the service has no endpoints, the pod selector labels don't match:

```bash
# Compare service selector with pod labels
kubectl get svc nextjs -n nextjs-app -o jsonpath='{.spec.selector}'
kubectl get pods -n nextjs-app --show-labels
```

---

## Step 6 — Verify Pod Health

### What to check

The Next.js pod must be Running and pass health checks.

### Commands (control plane SSM session)

```bash
# Pod status
kubectl get pods -n nextjs-app -l app=nextjs -o wide

# Detailed pod info (events, conditions)
kubectl describe pod -n nextjs-app -l app=nextjs

# Pod logs (last 50 lines)
kubectl logs -n nextjs-app -l app=nextjs --tail=50

# Direct health check to pod IP
POD_IP=$(kubectl get pods -n nextjs-app -l app=nextjs \
  -o jsonpath='{.items[0].status.podIP}')
curl -s -o /dev/null -w "%{http_code}" \
  --connect-timeout 5 http://$POD_IP:3000/api/health
```

### Expected result

- Pod status: `Running`, all containers `Ready`
- No `CrashLoopBackOff` or `Error` states
- Health check returns `200`

### Fix — Pod crash-looping due to missing secrets

```bash
# Check if secrets exist
kubectl get secret nextjs-secrets -n nextjs-app

# View secret keys (not values)
kubectl describe secret nextjs-secrets -n nextjs-app

# Restart deployment after secrets are created
kubectl rollout restart deployment/nextjs -n nextjs-app
```

> See the [Next.js Troubleshooting Guide](./nextjs-troubleshooting-guide.md) Steps 3–9 for detailed pod-level diagnostics.

---

## Step 7 — Verify Cross-Node Pod Networking (Calico)

### What to check

Pods on different nodes must be able to communicate. This is critical when Traefik receives traffic on one node but the Next.js pod runs on a different node.

### Commands (control plane SSM session)

```bash
# 1. Check Calico pods (they run in calico-system, not kube-system)
kubectl get pods -n calico-system -l k8s-app=calico-node -o wide

# 2. Check Calico VXLAN/IPIP mode
kubectl get ippools \
  -o jsonpath='{range .items[*]}{.metadata.name}: vxlanMode={.spec.vxlanMode}, ipipMode={.spec.ipipMode}{"\n"}{end}'

# 3. Test cross-node connectivity (from control plane to a pod on a worker)
POD_IP=$(kubectl get pods -n nextjs-app -l app=nextjs \
  -o jsonpath='{.items[0].status.podIP}')
ping -c 2 -W 2 $POD_IP

# 4. Check Calico routes
ip route | grep 192.168

# 5. Check VXLAN interface
ip link show | grep -E "tunl0|vxlan"

# 6. Check Calico Felix logs for errors
CALICO_POD=$(kubectl get pods -n calico-system \
  -l k8s-app=calico-node \
  --field-selector spec.nodeName=$(hostname) \
  -o jsonpath='{.items[0].metadata.name}')
kubectl logs -n calico-system $CALICO_POD -c calico-node \
  --tail=30 | grep -iE "error|warn|vxlan"
```

### Expected result

- 3 calico-node pods Running (one per node)
- `vxlanMode=CrossSubnet` or `Always`
- Ping to pod IP on another node succeeds (0% packet loss)
- Routes exist for remote pod CIDRs (e.g., `192.168.x.0/26 via 10.0.0.x`)
- VXLAN interface `vxlan.calico` is UP

### Fix — Cross-node traffic fails (100% packet loss)

**Cause: Source/destination check enabled on EC2 instances.**

With Calico `CrossSubnet` mode, same-subnet traffic uses direct routing (no encapsulation). EC2 drops packets with non-instance IPs unless source/dest check is disabled.

```bash
# Check source/dest check on all nodes (local machine)
for INSTANCE_ID in i-XXXXXXXXX i-YYYYYYYYY i-ZZZZZZZZZ; do
  STATUS=$(aws ec2 describe-instance-attribute \
    --instance-id $INSTANCE_ID \
    --attribute sourceDestCheck \
    --query "SourceDestCheck.Value" --output text \
    --region eu-west-1 --profile dev-account)
  echo "$INSTANCE_ID: sourceDestCheck=$STATUS"
done

# Disable on all nodes (if True)
aws ec2 modify-instance-attribute --instance-id <INSTANCE_ID> \
  --no-source-dest-check --region eu-west-1 --profile dev-account
```

> **Note:** The CDK stacks already set `disableSourceDestCheck: true` in the launch template. If it's still enabled, the instance may have been launched before this setting was added, or the launch template was overridden.

---

## Step 8 — Verify Security Group and NACLs

### What to check

The security group must allow HTTP/HTTPS from the internet and all inter-node traffic.

### Commands (local machine)

```bash
# Get the cluster security group
aws ec2 describe-instances \
  --instance-id <INSTANCE_ID> \
  --query "Reservations[0].Instances[0].SecurityGroups" \
  --output table --region eu-west-1 --profile dev-account

# Check inbound rules
aws ec2 describe-security-group-rules \
  --filter Name=group-id,Values=<SG_ID> \
  --query "SecurityGroupRules[?IsEgress==\`false\`].{Port:FromPort,Proto:IpProtocol,Source:CidrIpv4}" \
  --output table --region eu-west-1 --profile dev-account

# Check NACLs on the subnet
aws ec2 describe-network-acls \
  --filters "Name=association.subnet-id,Values=<SUBNET_ID>" \
  --query "NetworkAcls[0].Entries[?Egress==\`false\`]" \
  --output table --region eu-west-1 --profile dev-account
```

### Required Security Group Rules

| Port | Protocol | Source | Purpose |
|---|---|---|---|
| 80 | TCP | 0.0.0.0/0 | CloudFront → Traefik HTTP |
| 443 | TCP | 0.0.0.0/0 | HTTPS traffic |
| 6443 | TCP | VPC CIDR | K8s API (SSM port-forward) |
| -1 | All | Self (SG) | Intra-cluster (kubelet, VXLAN 4789, BGP 179, etcd) |

---

## Common Fixes Reference

### Fix 1 — Stale CloudFront Origin (504 from CloudFront)

**Symptoms:** `curl https://nelsonlamounier.com/` → 504, but `curl http://<EIP>/` → 200.

**Root cause:** CloudFront origin hostname doesn't match the current EIP.

**Fix:** Redeploy the edge stack:

```bash
# The edge stack re-reads the EIP from SSM on every deploy
npx cdk deploy KubernetesEdgeStack --region us-east-1 --profile dev-account

# Or trigger the deploy-edge pipeline job
```

### Fix 2 — EIP Unassociated (504 from direct EIP curl)

**Symptoms:** `curl http://<EIP>/` → connection refused or timeout.

**Root cause:** EIP is not attached to any instance.

**Fix:**

```bash
aws ec2 associate-address \
  --allocation-id <ALLOCATION_ID> \
  --instance-id <WORKER_INSTANCE_ID> \
  --allow-reassociation \
  --region eu-west-1 --profile dev-account
```

### Fix 3 — SSM Parameter Stale

**Symptoms:** SSM value doesn't match the actual EIP.

**Root cause:** Base stack was re-created with a new EIP but SSM wasn't updated.

**Fix:**

```bash
# Update SSM
aws ssm put-parameter --name "/k8s/development/elastic-ip" \
  --value "<CORRECT_EIP>" --overwrite \
  --region eu-west-1 --profile dev-account

# Then redeploy the edge stack to update CloudFront
```

### Fix 4 — Network Policy Blocking Traffic

**Symptoms:** `curl http://localhost/` → 504 on control plane, but works on the worker node where the pod runs.

**Root cause:** The `nextjs-allow-traefik` NetworkPolicy only allows from `kube-system` namespace. Traefik with `hostNetwork: true` may not be matched.

**Temporary diagnostic:** Delete the network policy and test:

```bash
kubectl delete networkpolicy nextjs-allow-traefik -n nextjs-app
curl -s -o /dev/null -w "%{http_code}" http://localhost/api/health
# ArgoCD will recreate the policy within ~3 minutes (selfHeal: true)
```

### Fix 5 — Source/Destination Check (cross-node networking)

**Symptoms:** 100% packet loss when pinging pod IPs on remote nodes.

**Root cause:** EC2 drops packets with non-instance destination IPs.

**Fix:**

```bash
aws ec2 modify-instance-attribute --instance-id <INSTANCE_ID> \
  --no-source-dest-check --region eu-west-1 --profile dev-account
```

### Fix 6 — Pod Not Receiving Secrets

**Symptoms:** Pod crash-loops with `Error: secret "nextjs-secrets" not found`.

**Root cause:** The `deploy-nextjs-secrets` pipeline job hasn't run yet or failed.

**Fix:**

```bash
# Verify the secret exists
kubectl get secret nextjs-secrets -n nextjs-app

# Decode and inspect values
kubectl get secret nextjs-secrets -n nextjs-app \
  -o jsonpath='{.data}' | jq 'to_entries[] | {key: .key, value: (.value | @base64d)}'

# Restart the deployment to pick up newly created secrets
kubectl rollout restart deployment/nextjs -n nextjs-app
```

---

## Glossary

| Term | Description |
|---|---|
| **EIP (Elastic IP)** | Static public IPv4 address allocated in AWS. Persists across instance stop/start cycles. |
| **CloudFront** | AWS CDN service that caches and distributes content globally. Terminates HTTPS and forwards HTTP to origin. |
| **Traefik** | Kubernetes-native reverse proxy / ingress controller. Runs as a DaemonSet with `hostNetwork: true`. |
| **IngressRoute** | Traefik-specific CRD that defines routing rules (replaces standard Kubernetes Ingress). |
| **Calico** | Kubernetes CNI plugin that handles pod networking. Uses VXLAN or direct routing for cross-node traffic. |
| **CrossSubnet** | Calico VXLAN mode that uses direct routing for same-subnet nodes and VXLAN for cross-subnet. |
| **Source/Dest Check** | AWS EC2 feature that drops packets with non-instance IPs. Must be disabled for Kubernetes CNI direct routing. |
| **WAF** | AWS Web Application Firewall. Attached to CloudFront for rate limiting and managed rule protection. |
| **SSM (Systems Manager)** | AWS service used for parameter storage and remote instance management (Session Manager). |
| **ArgoCD** | GitOps controller that syncs Kubernetes manifests from Git to the cluster. |
