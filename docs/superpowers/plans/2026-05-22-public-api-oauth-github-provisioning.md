<!-- @format -->

# public-api OAuth + GitHub Production Provisioning Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Provision the oauth-token KMS key + GitHub App secret + a least-privilege **EKS Pod Identity** role for public-api so the current `develop` image boots and all routes (cached projects reader + oauth/github-webhook) work in production.

**Architecture:** public-api currently uses the node instance profile and crashes on boot because its `config.ts` requires `OAUTH_TOKEN_KMS_KEY_ARN` + `GITHUB_APP_SECRET_ARN` (+ PG, already wired) that were never provisioned. We give public-api its own **Pod Identity** role (the cluster's IRSA equivalent — `eks-pod-identity-agent` + `CfnPodIdentityAssociation`, mirroring `ingestion`/`admin-api`), covering its **full** AWS footprint (DynamoDB read, Secrets Manager, KMS), provision the missing KMS key + GitHub App secret (seeded from existing material — no new credentials), and wire the chart.

**Tech Stack:** AWS CDK (cdk-monitoring kubernetes project + ai-applications bedrock project), KMS, Secrets Manager, SSM, EKS Pod Identity, Helm, External Secrets Operator, ArgoCD.

**No new credentials required** — GitHub App material already exists in dev:
- `appId` ← `k8s/development/tucaken-github-app.github_app_id`
- `privateKeyPem` ← `k8s/development/tucaken-github-app.github_app_private_key`
- `webhookSecret` ← SSM SecureString `/k8s/development/tucaken-webhook-secret`

**Known resource facts (dev-account 771826808455, eu-west-1):**
- Content DDB: `arn:aws:dynamodb:eu-west-1:771826808455:table/bedrock-dev-ai-content` (+ GSIs `gsi1-status-date`, `gsi2-tag-date`)
- Bedrock API key secret ARN: SSM `/bedrock-dev/bedrock-api-key-secret-arn`
- OIDC provider (present): `arn:aws:iam::771826808455:oidc-provider/oidc.eks.eu-west-1.amazonaws.com/id/0C17069DC0A97D7B45AC3A26768FA861`
- public-api SA target: namespace `public-api`, serviceAccount `public-api`

**Repos:** `ai-applications` (KMS/secret/SSM), `cdk-monitoring` (Pod Identity), `kubernetes-bootstrap` (chart). cdk-monitoring infra branch: `develop`.

---

## Phase 1 — ai-applications/infra: oauth KMS key + GitHub App secret + SSM

Mirror the existing constructs in `infra/lib/stacks/bedrock/data-stack.ts` (DataBucketKey at ~`:103`, IngestionGithubTokenSecret at ~`:209`, SSM `StringParameter` at ~`:284`). Deploy: `npx cdk deploy -c project=bedrock -c environment=dev` (the bedrock factory). Branch: `develop`.

### Task 1: oauth-token KMS key + SSM param

**Files:**
- Modify: `ai-applications/infra/lib/stacks/bedrock/data-stack.ts`
- Test: `ai-applications/infra/tests/unit/stacks/bedrock/data-stack.test.ts`

- [ ] **Step 1: Add a failing assertion** — in `data-stack.test.ts`, assert the template has a KMS key aliased `${namePrefix}-oauth-token` and an SSM param `/oauth/token-encryption-key-arn`:

```typescript
test('provisions oauth-token KMS key + SSM param', () => {
    // template = Template.fromStack(stack) already set up in this file's beforeAll/factory
    template.hasResourceProperties('AWS::KMS::Alias', {
        AliasName: Match.stringLikeRegexp('alias/.*-oauth-token'),
    });
    template.hasResourceProperties('AWS::SSM::Parameter', {
        Name: '/oauth/token-encryption-key-arn',
    });
});
```

- [ ] **Step 2: Run it, expect FAIL**

Run: `cd ai-applications/infra && yarn jest data-stack`
Expected: FAIL (no oauth alias / SSM param).

- [ ] **Step 3: Add the KMS key + SSM param** in `data-stack.ts` constructor (after the existing `encryptionKey` block, mirroring it):

```typescript
        // OAuth-token envelope-encryption CMK for public-api oauth_connections.
        const oauthTokenKey = new kms.Key(this, 'OAuthTokenKey', {
            alias: `${namePrefix}-oauth-token`,
            description: `KMS key for ${namePrefix} public-api oauth_connections token envelope encryption`,
            enableKeyRotation: true,
            removalPolicy: cdk.RemovalPolicy.RETAIN,
        });

        new ssm.StringParameter(this, 'OAuthTokenKeyArnParam', {
            parameterName: '/oauth/token-encryption-key-arn',
            stringValue: oauthTokenKey.keyArn,
            description: 'KMS CMK ARN for public-api oauth token envelope encryption',
        });
```

Expose the ARN for cross-stack/grant use:

```typescript
        // near the other `public readonly` fields (~:77)
        public readonly oauthTokenKeyArn: string;
        // in constructor, after creation:
        this.oauthTokenKeyArn = oauthTokenKey.keyArn;
```

- [ ] **Step 4: Run it, expect PASS**

Run: `cd ai-applications/infra && yarn jest data-stack`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ai-applications/infra/lib/stacks/bedrock/data-stack.ts ai-applications/infra/tests/unit/stacks/bedrock/data-stack.test.ts
git commit -m "feat(infra): provision oauth-token KMS key + SSM param for public-api"
```

### Task 2: GitHub App secret resource (IaC-owned, seeded out-of-band)

**Files:**
- Modify: `ai-applications/infra/lib/stacks/bedrock/data-stack.ts`
- Test: `ai-applications/infra/tests/unit/stacks/bedrock/data-stack.test.ts`

- [ ] **Step 1: Add a failing assertion**

```typescript
test('provisions public-api GitHub App secret (RETAIN)', () => {
    template.hasResource('AWS::SecretsManager::Secret', {
        Properties: { Name: 'k8s/development/public-api-github-app' },
        DeletionPolicy: 'Retain',
    });
});
```

- [ ] **Step 2: Run it, expect FAIL**

Run: `cd ai-applications/infra && yarn jest data-stack`
Expected: FAIL.

- [ ] **Step 3: Add the secret** (mirror `IngestionGithubTokenSecret` at ~`:209`, including the `AwsSolutions-SMG4` suppression):

```typescript
        // public-api GitHub App secret — consumed by public-api githubAppSecrets.ts
        // via GetSecretValue (one JSON: { appId, privateKeyPem, webhookSecret }).
        // Value injected out-of-band (scripts/seed-public-api-github-app.sh) from
        // existing tucaken-github-app + /k8s/development/tucaken-webhook-secret;
        // Secrets Manager cannot synthesise a GitHub App private key.
        const publicApiGithubApp = new secretsmanager.Secret(this, 'PublicApiGithubAppSecret', {
            secretName: 'k8s/development/public-api-github-app',
            description:
                'GitHub App credentials { appId, privateKeyPem, webhookSecret } for '
                + 'public-api github-webhook + oauth routes. Seeded out-of-band.',
        });
        publicApiGithubApp.applyRemovalPolicy(cdk.RemovalPolicy.RETAIN);
        NagSuppressions.addResourceSuppressions(publicApiGithubApp, [
            {
                id: 'AwsSolutions-SMG4',
                reason:
                    'GitHub App private key is an externally-issued credential injected '
                    + 'out-of-band; Secrets Manager cannot mint/rotate it.',
            },
        ]);

        new ssm.StringParameter(this, 'PublicApiGithubAppArnParam', {
            parameterName: '/k8s/development/public-api-github-app-arn',
            stringValue: publicApiGithubApp.secretArn,
            description: 'ARN of the public-api GitHub App secret (for GITHUB_APP_SECRET_ARN)',
        });
        this.publicApiGithubAppSecretArn = publicApiGithubApp.secretArn;
```

Add the `public readonly publicApiGithubAppSecretArn: string;` field (near `:77`).

- [ ] **Step 4: Run it, expect PASS**

Run: `cd ai-applications/infra && yarn jest data-stack`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ai-applications/infra/lib/stacks/bedrock/data-stack.ts ai-applications/infra/tests/unit/stacks/bedrock/data-stack.test.ts
git commit -m "feat(infra): provision public-api GitHub App secret resource"
```

### Task 3: Deploy Phase-1 infra + seed the GitHub App secret

**Files:**
- Create: `ai-applications/infra/scripts/seed-public-api-github-app.sh`

- [ ] **Step 1: Deploy the bedrock data stack**

Run: `cd ai-applications/infra && AWS_PROFILE=dev-account npx cdk deploy -c project=bedrock -c environment=dev Data-development`
Expected: KMS key, SSM `/oauth/token-encryption-key-arn`, secret `k8s/development/public-api-github-app` created.

- [ ] **Step 2: Write the seed script**

```bash
#!/usr/bin/env bash
# Seeds k8s/development/public-api-github-app from existing dev material.
# Idempotent: re-run safely. Requires AWS_PROFILE=dev-account.
set -euo pipefail
REGION=eu-west-1
GH=$(aws secretsmanager get-secret-value --secret-id k8s/development/tucaken-github-app --region "$REGION" --query SecretString --output text)
APP_ID=$(echo "$GH" | python3 -c "import sys,json;print(json.load(sys.stdin)['github_app_id'])")
PRIV=$(echo "$GH" | python3 -c "import sys,json;print(json.load(sys.stdin)['github_app_private_key'])")
HOOK=$(aws ssm get-parameter --name /k8s/development/tucaken-webhook-secret --with-decryption --region "$REGION" --query Parameter.Value --output text)
PAYLOAD=$(python3 -c "import json,sys;print(json.dumps({'appId':sys.argv[1],'privateKeyPem':sys.argv[2],'webhookSecret':sys.argv[3]}))" "$APP_ID" "$PRIV" "$HOOK")
aws secretsmanager put-secret-value --secret-id k8s/development/public-api-github-app --secret-string "$PAYLOAD" --region "$REGION"
echo "seeded public-api-github-app (keys: appId, privateKeyPem, webhookSecret)"
```

- [ ] **Step 3: Run the seed + verify shape**

Run:
```bash
chmod +x ai-applications/infra/scripts/seed-public-api-github-app.sh
AWS_PROFILE=dev-account ai-applications/infra/scripts/seed-public-api-github-app.sh
AWS_PROFILE=dev-account aws secretsmanager get-secret-value --secret-id k8s/development/public-api-github-app --region eu-west-1 --query SecretString --output text | python3 -c "import sys,json;print(sorted(json.load(sys.stdin).keys()))"
```
Expected: `['appId', 'privateKeyPem', 'webhookSecret']`

- [ ] **Step 4: Commit**

```bash
git add ai-applications/infra/scripts/seed-public-api-github-app.sh
git commit -m "chore(infra): seed script for public-api GitHub App secret"
```

---

## Phase 2 — cdk-monitoring: public-api Pod Identity role

Mirror the `admin-api` case in `infra/lib/stacks/kubernetes/eks-pod-identity-stack.ts` (~`:356`) and the binding in `infra/lib/config/eks/configurations.ts` (`COMMON_BINDINGS` ~`:104`, `PodIdentityBinding.purpose` union ~`:30`). Branch: `develop`. Deploy via the kubernetes project.

### Task 4: Add the public-api binding + purpose

**Files:**
- Modify: `cdk-monitoring/infra/lib/config/eks/configurations.ts`

- [ ] **Step 1: Add `'public-api'` to the `purpose` union** (in `PodIdentityBinding`, the `purpose: ... | 'admin-api' | ...` list ~`:30`):

```typescript
        | 'admin-api'
        | 'public-api'
```

- [ ] **Step 2: Add the binding to `COMMON_BINDINGS`** (after the `admin-api` entry ~`:111`):

```typescript
    { namespace: 'public-api',         serviceAccount: 'public-api',                  purpose: 'public-api' },
```

- [ ] **Step 3: Typecheck**

Run: `cd cdk-monitoring/infra && yarn typecheck`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add cdk-monitoring/infra/lib/config/eks/configurations.ts
git commit -m "feat(eks): add public-api Pod Identity binding"
```

### Task 5: public-api role policies (DDB + SM + KMS)

**Files:**
- Modify: `cdk-monitoring/infra/lib/stacks/kubernetes/eks-pod-identity-stack.ts`
- Test: `cdk-monitoring/infra/tests/unit/stacks/kubernetes/eks-pod-identity-stack.test.ts`

- [ ] **Step 1: Add a failing assertion** — assert the public-api role has a policy with the three statement sids:

```typescript
test('public-api role grants DDB read, SM read, KMS decrypt', () => {
    const stmts = template.findResources('AWS::IAM::Policy');
    const json = JSON.stringify(stmts);
    expect(json).toContain('PublicApiDynamoRead');
    expect(json).toContain('PublicApiSecretsRead');
    expect(json).toContain('PublicApiKmsDecrypt');
});
```

- [ ] **Step 2: Run it, expect FAIL**

Run: `cd cdk-monitoring/infra && yarn jest eks-pod-identity`
Expected: FAIL.

- [ ] **Step 3: Add `case 'public-api':`** in the switch (mirror `admin-api` at ~`:356`). Resources are dev ARNs; SM/KMS scoped to the specific secrets/key, DDB to the content table + indexes:

```typescript
            case 'public-api':
                // Read the AI content table + its GSIs (articles, resumes routes
                // via @bedrock/shared DynamoDB client).
                role.addToPolicy(
                    new iam.PolicyStatement({
                        sid: 'PublicApiDynamoRead',
                        actions: ['dynamodb:GetItem', 'dynamodb:Query', 'dynamodb:BatchGetItem'],
                        resources: [
                            'arn:aws:dynamodb:eu-west-1:771826808455:table/bedrock-dev-ai-content',
                            'arn:aws:dynamodb:eu-west-1:771826808455:table/bedrock-dev-ai-content/index/*',
                        ],
                    }),
                );
                // Fetch the Bedrock chatbot API key + the GitHub App secret at runtime.
                role.addToPolicy(
                    new iam.PolicyStatement({
                        sid: 'PublicApiSecretsRead',
                        actions: ['secretsmanager:GetSecretValue'],
                        resources: [
                            'arn:aws:secretsmanager:eu-west-1:771826808455:secret:k8s/development/public-api-github-app-*',
                            'arn:aws:secretsmanager:eu-west-1:771826808455:secret:bedrock-development/*',
                        ],
                    }),
                );
                // Decrypt oauth_connections tokens (github-webhook route).
                role.addToPolicy(
                    new iam.PolicyStatement({
                        sid: 'PublicApiKmsDecrypt',
                        actions: ['kms:Decrypt', 'kms:DescribeKey'],
                        resources: ['*'], // dev: oauth key ARN not available at synth; tighten once exported cross-stack
                    }),
                );
                break;
```

> Note: KMS `resources: ['*']` matches the dev rationale used elsewhere in this stack (ARNs not available at synth). Tighten to the `${namePrefix}-oauth-token` key ARN when cross-stack export is wired. The bedrock API key lives under `bedrock-development/*`; confirm the exact secret name from SSM `/bedrock-dev/bedrock-api-key-secret-arn` and narrow if desired.

- [ ] **Step 4: Run it, expect PASS**

Run: `cd cdk-monitoring/infra && yarn jest eks-pod-identity`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add cdk-monitoring/infra/lib/stacks/kubernetes/eks-pod-identity-stack.ts cdk-monitoring/infra/tests/unit/stacks/kubernetes/eks-pod-identity-stack.test.ts
git commit -m "feat(eks): public-api Pod Identity role (DDB read, SM read, KMS decrypt)"
```

### Task 6: Deploy the Pod Identity stack

- [ ] **Step 1: Deploy** (use the kubernetes project's deploy path; confirm the stack name via `npx cdk list -c project=kubernetes -c environment=development`):

Run: `cd cdk-monitoring/infra && AWS_PROFILE=dev-account npx cdk deploy -c project=kubernetes -c environment=development <EksPodIdentityStackName>`
Expected: a new IAM role + `CfnPodIdentityAssociation` for `public-api/public-api`.

- [ ] **Step 2: Verify the association**

Run: `AWS_PROFILE=dev-account aws eks list-pod-identity-associations --cluster-name k8s-eks-development --region eu-west-1 --query "associations[?namespace=='public-api']"`
Expected: one association for serviceAccount `public-api`.

---

## Phase 3 — kubernetes-bootstrap: public-api ServiceAccount + env

The pod must run as the `public-api` ServiceAccount for Pod Identity to bind. Branch: `develop` (then promote to `main`).

### Task 7: ServiceAccount + serviceAccountName

**Files:**
- Create: `kubernetes-bootstrap/charts/public-api/chart/templates/serviceaccount.yaml`
- Modify: `kubernetes-bootstrap/charts/public-api/chart/templates/deployment.yaml`

- [ ] **Step 1: Create the ServiceAccount** (mirror `charts/ingestion/chart/templates/ingestion-sa.yaml`; Pod Identity needs **no** role-arn annotation — the association binds by namespace+SA):

```yaml
# @format
# ServiceAccount for public-api. Bound to an IAM role via EKS Pod Identity
# (cdk-monitoring EksPodIdentityStack: namespace=public-api, sa=public-api).
# Grants DynamoDB read, Secrets Manager read, KMS decrypt. Without the
# association the pod falls back to the node role (must not be relied on).
apiVersion: v1
kind: ServiceAccount
metadata:
  name: public-api
  namespace: {{ .Values.namespace }}
  labels:
    app.kubernetes.io/name: {{ .Release.Name }}
    app.kubernetes.io/managed-by: {{ .Release.Service }}
```

- [ ] **Step 2: Set `serviceAccountName` on the Deployment** — in `deployment.yaml`, in the pod `spec:` (the `template.spec`), add as the first line under `spec:`:

```yaml
      serviceAccountName: public-api
```

- [ ] **Step 3: Lint + render**

Run: `cd kubernetes-bootstrap && helm lint charts/public-api/chart && helm template charts/public-api/chart | grep -E "kind: ServiceAccount|serviceAccountName:"`
Expected: ServiceAccount rendered + `serviceAccountName: public-api` on the pod.

- [ ] **Step 4: Commit**

```bash
git add kubernetes-bootstrap/charts/public-api/chart/templates/serviceaccount.yaml kubernetes-bootstrap/charts/public-api/chart/templates/deployment.yaml
git commit -m "feat(public-api): ServiceAccount for EKS Pod Identity"
```

### Task 8: ESO + env for the two ARNs

**Files:**
- Create: `kubernetes-bootstrap/charts/public-api/external-secrets/public-api-auth.yaml`
- Modify: `kubernetes-bootstrap/charts/public-api/chart/templates/deployment.yaml`

- [ ] **Step 1: Create the ExternalSecret** (pulls the two ARNs from SSM via the `aws-ssm` store):

```yaml
# @format
# ExternalSecret: public-api-auth
# OAUTH_TOKEN_KMS_KEY_ARN + GITHUB_APP_SECRET_ARN (identifiers, not secrets —
# the protected material is fetched at runtime via Pod Identity). Sourced from
# SSM params published by ai-applications data-stack.
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: public-api-auth
  namespace: public-api
  annotations:
    kubernetes.io/description: "public-api oauth KMS + GitHub App ARNs from SSM"
spec:
  refreshInterval: 1h
  secretStoreRef:
    name: aws-ssm
    kind: ClusterSecretStore
  target:
    name: public-api-auth
    creationPolicy: Owner
    deletionPolicy: Delete
  data:
    - secretKey: OAUTH_TOKEN_KMS_KEY_ARN
      remoteRef:
        key: /oauth/token-encryption-key-arn
    - secretKey: GITHUB_APP_SECRET_ARN
      remoteRef:
        key: /k8s/development/public-api-github-app-arn
```

- [ ] **Step 2: Add `envFrom` + Reloader** — in `deployment.yaml` add to `envFrom`:

```yaml
            - secretRef:
                name: public-api-auth
```

and append `,public-api-auth` to the `secret.reloader.stakater.com/reload` annotation value.

- [ ] **Step 3: Lint**

Run: `cd kubernetes-bootstrap && helm lint charts/public-api/chart`
Expected: 0 failed.

- [ ] **Step 4: Commit**

```bash
git add kubernetes-bootstrap/charts/public-api/
git commit -m "feat(public-api): wire OAUTH_TOKEN_KMS_KEY_ARN + GITHUB_APP_SECRET_ARN via ESO"
```

---

## Phase 4 — Deploy + verify reader boot

- [ ] **Step 1: Promote** kubernetes-bootstrap `develop → main` (PR) so ArgoCD reconciles the SA + ESO. (ai-applications + cdk-monitoring infra already deployed in Phases 1–2.)

- [ ] **Step 2: Confirm ESO synced + SA bound**

```bash
kubectl -n public-api get secret public-api-auth
kubectl -n public-api get sa public-api
```
Expected: secret has `OAUTH_TOKEN_KMS_KEY_ARN` + `GITHUB_APP_SECRET_ARN`; SA exists.

- [ ] **Step 3: Confirm the reader pod boots (no CrashLoop)**

```bash
kubectl -n public-api rollout status deploy/public-api --timeout=120s
kubectl -n public-api get pods -l app.kubernetes.io/name=public-api
```
Expected: new pod Ready, image `1292062…` (or newer), 0 restarts.

- [ ] **Step 4: Phase E cache checks** (now unblocked):
  - `kubectl -n public-api exec deploy/public-api -- wget -qO- localhost:3001/metrics | grep redis_cache_requests_total` → counter present.
  - Hit a public project URL twice → `redis_cache_requests_total{result="hit"}` increments; key appears in redis-cache (`KEYS 'shared:project:case_study:*'`).
  - Edit that project via admin-api → key gone + `redis_cache_invalidations_total{result="ok"}` increments.
  - Scale redis-cache to 0 → endpoint still 200 (fail-open) + `result="error"` increments; scale back.

---

## Self-Review

- **Spec coverage:** KMS key (T1), GitHub secret + seed (T2–T3), Pod Identity binding + role covering DDB/SM/KMS — public-api's full footprint (T4–T6), chart SA + Pod Identity (T7), ARN env wiring (T8), deploy + reader-boot + Phase-E (Phase 4). All covered.
- **Pattern fidelity:** every CDK task cites the existing construct to mirror (data-stack KMS/secret/SSM; pod-identity `admin-api` case; `ingestion-sa` SA). The `admin-api` Pod Identity case is the canonical zero-placeholder reference for statement structure.
- **Open items to confirm at execution:** exact `EksPodIdentityStack` stack name (`cdk list`); the bedrock API key secret's exact name (narrow `bedrock-development/*` if desired); whether cdk-monitoring/ai-applications infra deploy via CI or manual `cdk deploy` (manual shown).
- **Full-footprint caveat:** because Pod Identity replaces the node profile for the pod, the role MUST cover DDB + SM + KMS (done) — if public-api later calls another AWS service, extend the `public-api` case.
