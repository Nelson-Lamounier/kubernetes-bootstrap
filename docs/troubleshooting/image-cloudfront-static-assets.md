---
title: Image and CloudFront Static Assets Troubleshooting
type: troubleshooting
tags: [cloudfront, ecr, image-updater, argocd, s3, kubernetes]
sources:
  - argocd-apps/argocd-image-updater.yaml
created: 2026-04-28
updated: 2026-04-28
---

# Image & CloudFront Static Assets Troubleshooting Guide

A beginner-friendly, step-by-step guide to diagnosing and resolving **image discrepancies** between the running Kubernetes container, the ECR registry, and the S3/CloudFront static assets layer. All commands are run from the **control-plane node** via an AWS SSM session unless otherwise noted.

---

## Table of Contents

- [Prerequisites](#prerequisites)
- [Key Concepts Before You Start](#key-concepts-before-you-start)
- [Step 1 — Identify the Running Container Image](#step-1--identify-the-running-container-image)
- [Step 2 — Check ECR for Available Image Tags](#step-2--check-ecr-for-available-image-tags)
- [Step 3 — Compare Container Static Assets with S3](#step-3--compare-container-static-assets-with-s3)
- [Step 4 — Verify CloudFront Is Serving Correct Assets](#step-4--verify-cloudfront-is-serving-correct-assets)
- [Step 5 — Check ArgoCD Image Updater](#step-5--check-argocd-image-updater)
- [Step 6 — Update the Running Image](#step-6--update-the-running-image)
- [Step 7 — End-to-End Validation](#step-7--end-to-end-validation)
- [Troubleshooting — Common Issues](#troubleshooting--common-issues)
  - [Issue 1: CSS/JS 404s — Container and S3 Have Different Build Hashes](#issue-1-cssjs-404s--container-and-s3-have-different-build-hashes)
  - [Issue 2: ArgoCD Image Updater Cannot List ECR Tags](#issue-2-argocd-image-updater-cannot-list-ecr-tags)
  - [Issue 3: ArgoCD Self-Heal Reverts Manual Image Changes](#issue-3-argocd-self-heal-reverts-manual-image-changes)
  - [Issue 4: `:latest` Tag Is Stale in ECR](#issue-4-latest-tag-is-stale-in-ecr)
  - [Issue 5: CloudFront Cache Invalidation Not Configured](#issue-5-cloudfront-cache-invalidation-not-configured)
  - [Issue 6: Pod Not Pulling Updated `:latest` Image](#issue-6-pod-not-pulling-updated-latest-image)
- [Glossary](#glossary)

---

## Prerequisites

Before following this guide, ensure you have:

- **AWS CLI** installed and configured with a named profile (e.g., `dev-account`)
- **SSM Plugin** for the AWS CLI installed
- **kubectl** access to the cluster (via SSM session on the control plane)
- The Next.js application is deployed to the `nextjs-app` namespace
- Static assets are hosted on S3 and served via CloudFront

---

## Key Concepts Before You Start

### How the Deployment Pipeline Works

The Next.js frontend deployment pipeline (`deploy-frontend-dev.yml`) builds, pushes, and syncs in three parallel tracks:

```text
┌──────────────────────────────────────────────────────────────────────┐
│                    Deploy Frontend Pipeline                          │
│                                                                      │
│  1. build-and-push ─┬─→ 2. sync-assets (S3 + CloudFront)           │
│     (Docker image)  │                                                │
│     tagged with     ├─→ 3. deploy-to-cluster (SSM parameter)        │
│     ${{ github.sha }}                                                │
│                     └─→ 4. migrate-articles (DynamoDB)              │
└──────────────────────────────────────────────────────────────────────┘
```

> [!IMPORTANT]
> The container image and the S3 static assets **must come from the same build**. If they get out of sync (e.g., one updates without the other), CSS and JS files will 404 because Next.js embeds content-hashed filenames at build time.

### Why Hashes Matter

Next.js generates **content-hashed filenames** for CSS and JavaScript:

```text
.next/static/css/d3f953dee4df348d.css
.next/static/chunks/1255-4c9be8da1ab0fb38.js
```

The HTML rendered by the container references these exact filenames. If the container was built at a different time than the S3 sync, the filenames won't match and the browser gets 404 errors.

### Architecture Overview

```text
┌────────────────────┐
│  Browser Request   │
└─────────┬──────────┘
          │
          ├──→ HTML/SSR ──→ Kubernetes Pod (nextjs-app namespace)
          │                   └── image: ECR nextjs-frontend:<tag>
          │                         └── /app/.next/static/css/<hash>.css
          │
          └──→ /_next/static/* ──→ CloudFront ──→ S3 Bucket
                                      └── _next/static/css/<hash>.css
                                          ↑
                                  THESE HASHES MUST MATCH
```

### Where Things Live

| Component | Location |
|---|---|
| **Container Image** | ECR: `<account>.dkr.ecr.<region>.amazonaws.com/nextjs-frontend` |
| **Static Assets** | S3: `nextjs-article-assets-<env>` under `_next/static/` |
| **CloudFront** | Distribution fronting the S3 bucket |
| **ArgoCD Application** | `nextjs` application in `argocd` namespace |
| **Kubernetes Deployment** | `nextjs` deployment in `nextjs-app` namespace |
| **Image Updater** | `argocd-image-updater` in `argocd` namespace |

---

## Step 1 — Identify the Running Container Image

### 1a — Check the Pod Image

```bash
kubectl get pods -n nextjs-app -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.spec.containers[*].image}{"\n"}{end}'
```

| Flag | Meaning |
|---|---|
| `-n nextjs-app` | Target the Next.js application namespace. |
| `-o jsonpath=...` | Extract pod name and image in tab-separated format. |

#### What Success Looks Like

```text
nextjs-699bf767c4-f7zfb    771826808455.dkr.ecr.eu-west-1.amazonaws.com/nextjs-frontend:0f850eee58...
```

The image tag should be a **SHA hash** (7-40 hex characters), not `:latest`. If it shows `:latest`, the ArgoCD Image Updater may not be working — see [Step 5](#step-5--check-argocd-image-updater).

### 1b — Check the Deployment Image

```bash
kubectl describe deployment nextjs -n nextjs-app | grep Image
```

This shows the image configured in the Deployment spec (may differ from what the pod is actually running if a rollout is in progress).

### 1c — Check Pod Age and Restart Count

```bash
kubectl get pods -n nextjs-app
```

| Column | What to look for |
|---|---|
| `AGE` | If the pod is very old (e.g., 25h), it may be running a stale image. |
| `RESTARTS` | High restarts suggest crash loops — check logs. |
| `STATUS` | Should be `Running` with `1/1` Ready. |

### 1d — Check the CSS Hash Inside the Container

```bash
kubectl exec -n nextjs-app deploy/nextjs -- ls /app/.next/static/css/
```

Record this hash — you'll compare it with S3 in Step 3.

---

## Step 2 — Check ECR for Available Image Tags

### 2a — List Recent Images in ECR

Run this from your **local machine** (with AWS CLI configured):

```bash
aws ecr describe-images \
  --repository-name nextjs-frontend \
  --query 'sort_by(imageDetails,& imagePushedAt)[-5:].{tags:imageTags,pushed:imagePushedAt}' \
  --output table \
  --region eu-west-1 \
  --profile dev-account
```

| Flag | Meaning |
|---|---|
| `--repository-name` | The ECR repository to query. |
| `sort_by(...imagePushedAt)[-5:]` | Sort by push time, show last 5 images. |

#### What to Check

| Observation | Meaning |
|---|---|
| `:latest` tag on an **old** image | Pipeline isn't updating `:latest`, pod may pull stale image. |
| SHA tags on the **newest** image | Pipeline is pushing correctly with commit SHA tags. |
| No SHA tags at all | Pipeline build may have failed. |

### 2b — Compare ECR Tags with Running Pod

```bash
# What the pod is running
kubectl get pods -n nextjs-app -o jsonpath='{.items[0].spec.containers[0].image}'

# What ECR has as the latest push
aws ecr describe-images --repository-name nextjs-frontend \
  --query 'sort_by(imageDetails,& imagePushedAt)[-1:].imageTags' \
  --output text --region eu-west-1 --profile dev-account
```

If the pod's tag doesn't match the latest ECR push, the image needs updating.

---

## Step 3 — Compare Container Static Assets with S3

### 3a — List CSS Files in S3

From your **local machine**:

```bash
aws s3 ls s3://nextjs-article-assets-development/_next/static/ \
  --recursive --region eu-west-1 --profile dev-account | grep "\.css"
```

### 3b — List CSS Files in the Running Container

From the **SSM session**:

```bash
kubectl exec -n nextjs-app deploy/nextjs -- ls /app/.next/static/css/
```

### 3c — Compare

| S3 CSS Hash | Container CSS Hash | Status | Action |
|---|---|---|---|
| `d3f953dee4df348d.css` | `d3f953dee4df348d.css` | ✅ In Sync | No action needed. |
| `d3f953dee4df348d.css` | `4f451864e56822f1.css` | ❌ Mismatch | Update the container or re-sync S3. See [Issue 1](#issue-1-cssjs-404s--container-and-s3-have-different-build-hashes). |

> [!IMPORTANT]
> If the hashes don't match, the browser will get **404 errors** for CSS and JS files, resulting in an unstyled or broken page.

---

## Step 4 — Verify CloudFront Is Serving Correct Assets

### 4a — Get the CloudFront Distribution

From your **local machine**:

```bash
aws cloudfront list-distributions \
  --query 'DistributionList.Items[*].[Id,DomainName,Origins.Items[0].DomainName]' \
  --output table --profile dev-account
```

### 4b — Test a Static Asset via CloudFront

Use a CSS or JS filename from the S3 listing in Step 3a:

```bash
curl -I https://<CLOUDFRONT_DOMAIN>/_next/static/css/<HASH>.css
```

#### What Success Looks Like

```text
HTTP/2 200
content-type: text/css
cache-control: public, max-age=31536000, immutable
x-cache: Hit from cloudfront
```

#### Understanding Response Headers

| Header | Good Value | Problem Value |
|---|---|---|
| `HTTP/2` | `200` | `403` (S3 permissions) or `404` (file doesn't exist) |
| `x-cache` | `Hit from cloudfront` | `Miss from cloudfront` (first request — normal) |
| `cache-control` | `public, max-age=31536000, immutable` | Missing (sync script issue) |
| `content-type` | `text/css` or `application/javascript` | `application/octet-stream` (MIME type issue) |

### 4c — Verify the Container's CSS Exists in CloudFront

Test the **container's** CSS hash (from Step 1d) against CloudFront:

```bash
curl -I https://<CLOUDFRONT_DOMAIN>/_next/static/css/<CONTAINER_HASH>.css
```

If this returns **404**, the container is requesting a CSS file that doesn't exist in S3 — confirming a build mismatch.

---

## Step 5 — Check ArgoCD Image Updater

The ArgoCD Image Updater automatically detects new SHA-tagged images in ECR and updates the deployment.

### 5a — Check Image Updater Logs

```bash
kubectl logs -n argocd -l app.kubernetes.io/name=argocd-image-updater --tail=30
```

#### What Success Looks Like

```text
level=info msg="Successfully updated image '<repo>/nextjs-frontend:abc1234f'"
level=info msg="Processing results: applications=1 images_considered=1 images_updated=1 errors=0"
```

#### Common Errors

| Log Message | Root Cause | Fix |
|---|---|---|
| `not authorized to perform: ecr:ListImages` | Worker IAM role missing ECR permissions. | Add `ecr:ListImages` and `ecr:DescribeImages` to the IAM policy. See [Issue 2](#issue-2-argocd-image-updater-cannot-list-ecr-tags). |
| `"latest" strategy has been renamed to "newest-build"` | Deprecated strategy name in annotations. | Update annotation to `newest-build`. |
| `no new image found` | No images match the tag filter. | Check `allow-tags` regex and ECR tags. |

### 5b — Check the ArgoCD Application Annotations

```bash
kubectl get application nextjs -n argocd \
  -o jsonpath='{.metadata.annotations}' | python3 -m json.tool
```

#### Required Annotations

| Annotation | Expected Value |
|---|---|
| `argocd-image-updater.argoproj.io/image-list` | `nextjs=<account>.dkr.ecr.<region>.amazonaws.com/nextjs-frontend` |
| `argocd-image-updater.argoproj.io/nextjs.update-strategy` | `newest-build` |
| `argocd-image-updater.argoproj.io/nextjs.allow-tags` | `regexp:^[0-9a-f]{7,40}$` |
| `argocd-image-updater.argoproj.io/write-back-method` | `argocd` |

---

## Step 6 — Update the Running Image

### 6a — Update via ArgoCD (Recommended)

When ArgoCD `selfHeal` is enabled, direct `kubectl set image` changes **will be reverted**. Use ArgoCD parameter overrides instead:

```bash
kubectl patch application nextjs -n argocd --type merge -p '{
  "spec": {
    "source": {
      "helm": {
        "parameters": [
          {"name": "image.tag", "value": "<SHA_TAG>"}
        ]
      }
    }
  }
}'
```

| Flag | Meaning |
|---|---|
| `patch application` | Modify the ArgoCD Application resource. |
| `--type merge` | Merge the new JSON into the existing spec. |
| `image.tag` | The Helm value that controls the container image tag. |

> [!IMPORTANT]
> Replace `<SHA_TAG>` with the actual SHA commit hash from ECR (Step 2a). Use the tag from the **same build** that synced assets to S3.

#### Verify Rollout

```bash
kubectl get pods -n nextjs-app -w
```

Wait for the new pod to show `1/1 Running` and the old pod to terminate.

### 6b — Direct Image Update (When ArgoCD Self-Heal Is Disabled)

If the ArgoCD application does **not** have `selfHeal: true`:

```bash
kubectl set image deployment/nextjs -n nextjs-app \
  nextjs=<account>.dkr.ecr.<region>.amazonaws.com/nextjs-frontend:<SHA_TAG>
```

Then verify:

```bash
kubectl rollout status deployment/nextjs -n nextjs-app --timeout=120s
```

### 6c — Force Re-Sync from ArgoCD

If ArgoCD is stuck on a stale cached version:

```bash
kubectl -n argocd patch application nextjs \
  --type=merge -p '{"metadata":{"annotations":{"argocd.argoproj.io/refresh":"hard"}}}'
```

---

## Step 7 — End-to-End Validation

### 7a — Confirm Container CSS Matches S3

```bash
# Container CSS
kubectl exec -n nextjs-app deploy/nextjs -- ls /app/.next/static/css/

# S3 CSS
aws s3 ls s3://nextjs-article-assets-development/_next/static/css/ \
  --region eu-west-1 --profile dev-account
```

Both should show the **exact same filename**.

### 7b — Test via CloudFront

```bash
curl -I https://<CLOUDFRONT_DOMAIN>/_next/static/css/<HASH>.css
```

Expected: `HTTP/2 200` with `cache-control: public, max-age=31536000, immutable`.

### 7c — Test in Browser

Open the application URL in a browser and verify:

1. Page is fully styled (CSS loaded)
2. JavaScript interactions work (JS loaded)
3. Open **DevTools → Network** tab and confirm no 404s for `_next/static/*` requests

---

## Troubleshooting — Common Issues

---

### Issue 1: CSS/JS 404s — Container and S3 Have Different Build Hashes

#### Symptoms

- Page loads but is **unstyled** (no CSS)
- Browser DevTools shows **404** errors for `/_next/static/css/*.css`
- Container CSS hash (Step 1d) ≠ S3 CSS hash (Step 3a)

#### Root Cause

The container image and the S3 static assets were produced by **different builds**. This happens when:

1. The CI pipeline pushed a new image to ECR but the S3 sync ran from a different build
2. The `:latest` tag in ECR points to an old build while S3 was synced from a new build
3. ArgoCD Image Updater hasn't picked up the new SHA-tagged image yet

#### Fix

**Option A — Run the full frontend pipeline** (recommended):

Trigger `Deploy Frontend (Dev)` via GitHub Actions → workflow_dispatch. This builds, pushes, and syncs from the same build in one pipeline run.

**Option B — Update the container to match S3**:

Find the SHA tag from the ECR image pushed at the same time as the S3 sync (matching timestamps), then update via ArgoCD:

```bash
kubectl patch application nextjs -n argocd --type merge -p '{
  "spec": {
    "source": {
      "helm": {
        "parameters": [
          {"name": "image.tag", "value": "<MATCHING_SHA_TAG>"}
        ]
      }
    }
  }
}'
```

**Option C — Re-sync S3 from the current container**:

If you want to keep the current container image and update S3 to match, re-run the frontend pipeline.

---

### Issue 2: ArgoCD Image Updater Cannot List ECR Tags

#### Symptoms

- Image Updater logs show: `not authorized to perform: ecr:ListImages`
- Pod image tag never updates from `:latest`
- `errors=1` in every processing cycle

#### Root Cause

The worker node IAM role is missing `ecr:ListImages` and `ecr:DescribeImages` permissions.

#### Diagnosis

```bash
kubectl logs -n argocd -l app.kubernetes.io/name=argocd-image-updater --tail=10
```

#### Fix

Add the permissions to the CDK stack (`infra/lib/stacks/kubernetes/app-worker-stack.ts`):

```typescript
// Grant ECR pull + list for container images
launchTemplateConstruct.addToRolePolicy(new iam.PolicyStatement({
    sid: 'EcrPullImages',
    effect: iam.Effect.ALLOW,
    actions: [
        'ecr:GetDownloadUrlForLayer',
        'ecr:BatchGetImage',
        'ecr:BatchCheckLayerAvailability',
        'ecr:ListImages',        // ← Required for Image Updater
        'ecr:DescribeImages',    // ← Required for Image Updater
    ],
    resources: [`arn:aws:ecr:${this.region}:${this.account}:repository/*`],
}));
```

Then redeploy the CDK stack to update the IAM policy.

---

### Issue 3: ArgoCD Self-Heal Reverts Manual Image Changes

#### Symptoms

- `kubectl set image` succeeds but the new pod enters `Error` or `Terminating` within seconds
- The old pod continues running
- ArgoCD logs show a sync was triggered

#### Root Cause

The ArgoCD `nextjs` application has `selfHeal: true` in its sync policy. Any manual changes that deviate from the Git-defined state are automatically reverted.

#### Fix

Use the ArgoCD parameter override method instead of `kubectl set image`:

```bash
kubectl patch application nextjs -n argocd --type merge -p '{
  "spec": {
    "source": {
      "helm": {
        "parameters": [
          {"name": "image.tag", "value": "<SHA_TAG>"}
        ]
      }
    }
  }
}'
```

This modifies the ArgoCD Application spec itself, so ArgoCD treats it as the desired state and deploys accordingly.

---

### Issue 4: `:latest` Tag Is Stale in ECR

#### Symptoms

- ECR shows `:latest` was pushed weeks ago
- Newest images only have SHA tags
- Pod pulls `:latest` and gets an old build

#### Root Cause

The CI pipeline pushes images tagged with `${{ github.sha }}` but never updates the `:latest` tag. The `:latest` tag permanently points to an old build.

#### Fix

The ArgoCD Image Updater should be handling tag selection (using SHA tags, not `:latest`). Ensure:

1. Image Updater is running and healthy (Step 5)
2. IAM permissions include `ecr:ListImages` (Issue 2)
3. The `allow-tags` regex matches SHA format: `regexp:^[0-9a-f]{7,40}$`

Once the Image Updater works, it ignores `:latest` and selects the newest SHA-tagged image by build timestamp.

---

### Issue 5: CloudFront Cache Invalidation Not Configured

#### Symptoms

- S3 has updated files but CloudFront serves old versions
- `sync-static-to-s3.ts` logs show: `CloudFront distribution ID not found in SSM. Skipping invalidation.`

#### Root Cause

The SSM parameter `/nextjs/<env>/cloudfront/distribution-id` doesn't exist, so the sync script can't invalidate the CloudFront cache.

#### Fix

Create the SSM parameter:

```bash
aws ssm put-parameter \
  --name "/nextjs/development/cloudfront/distribution-id" \
  --value "<DISTRIBUTION_ID>" \
  --type String \
  --region eu-west-1 \
  --profile dev-account
```

Get the distribution ID with:

```bash
aws cloudfront list-distributions \
  --query 'DistributionList.Items[*].[Id,Origins.Items[0].DomainName]' \
  --output table --profile dev-account
```

> [!NOTE]
> For immutable static assets (`_next/static/*`), CloudFront invalidation is rarely needed because the content-hashed filenames change on each build. However, it's useful for cache consistency and to clean up old URLs.

---

### Issue 6: Pod Not Pulling Updated `:latest` Image

#### Symptoms

- ECR `:latest` tag was updated but `kubectl rollout restart` still runs the old image
- Pod image shows `:latest` but content is stale

#### Root Cause

Kubernetes default `imagePullPolicy` for named tags (like `:latest`) is `IfNotPresent` — if the image is already cached on the node, Kubernetes won't re-pull even if the tag was updated in the registry.

#### Fix

Force a re-pull by restarting the deployment:

```bash
kubectl rollout restart deployment nextjs -n nextjs-app
```

If that still doesn't work, the image may be cached on the node. Delete the old pod directly:

```bash
kubectl delete pod -n nextjs-app -l app=nextjs
```

For a permanent fix, set `imagePullPolicy: Always` in the Helm chart values:

```yaml
image:
  pullPolicy: Always
```

> [!IMPORTANT]
> Using `imagePullPolicy: Always` with `:latest` is discouraged in production. Prefer SHA-tagged images with the ArgoCD Image Updater for deterministic deployments.

---

## Glossary

| Term | Definition |
|---|---|
| **ECR** | Elastic Container Registry — AWS's Docker image repository service. |
| **CloudFront** | AWS's Content Delivery Network (CDN), serving static files from edge locations. |
| **Content Hash** | A hash computed from the file's content (e.g., `d3f953dee4df348d`). If the content changes, the hash changes. |
| **ArgoCD Image Updater** | A companion tool to ArgoCD that watches container registries and automatically updates image tags in ArgoCD Applications. |
| **Self-Heal** | ArgoCD feature that detects manual cluster changes and automatically reverts them to match the Git-defined state. |
| **imagePullPolicy** | Kubernetes setting controlling when the container runtime pulls images: `Always`, `IfNotPresent`, or `Never`. |
| **SSM Parameter** | AWS Systems Manager Parameter Store — key-value store used for sharing configuration between infrastructure components. |
| **SHA Tag** | A git commit SHA used as a Docker image tag (e.g., `0f850eee58925312417aec54cccc03a9dfbe1d74`), providing an immutable link between code and image. |
| **Immutable Cache** | `Cache-Control: immutable` tells browsers and CDNs the content at this URL will never change. Safe because content-hashed filenames change when content changes. |
