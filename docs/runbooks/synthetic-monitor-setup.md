<!-- @format -->

# Runbook — Synthetic Monitor setup

The synthetic monitor is an in-cluster CronJob (`charts/monitoring`,
`syntheticMonitor.*`) that drives the real auth + resume-import workflows and
asserts Prometheus reflects them. It guards the **Auth — Sign-In / Sign-Up
Workflow** and **Resume Import — Upload to Career Entries** dashboards.

Most of the chain is GitOps:

```
cdk-monitoring (ECR repo) → ai-applications deploy-synthetic-monitor.yml (build/push)
  → ArgoCD Image Updater (monitoring app) → synthetic-monitor CronJob
  → synthetic_check_success → SyntheticCheck{Failing,Absent} alerts
```

Three things **cannot** be codified and are done manually per environment.

---

## 1. Cognito synthetic user + SSM credentials  ✅ done in `development`

The probe authenticates as a dedicated Cognito user via `USER_PASSWORD_AUTH`
and reads its creds from SSM (synced into the cluster by the
`synthetic-monitor-secret` ExternalSecret).

- **Pool**: `portfolio-admin-admin-pool` (`eu-west-1_mNRJM2InT`)
- **App client**: `portfolio-admin-nextjs-client` (`3jtefdlkq4ipg7mlrkhprmob06`)
  — already allows `USER_PASSWORD_AUTH` with no client secret.
- **User**: `synthetic-monitor@noreply.nelsonlamounier.com` (group `admin`)

Recreate / rotate (dev account, eu-west-1):

```bash
POOL=eu-west-1_mNRJM2InT
CLIENT=3jtefdlkq4ipg7mlrkhprmob06
USER=synthetic-monitor@noreply.nelsonlamounier.com
P() { aws "$@" --profile dev-account --region eu-west-1; }

# strong password meeting the pool policy (>=12, upper/lower/digit/symbol)
PW=$(python3 -c "import secrets,string,random;a=string.ascii_uppercase;b=string.ascii_lowercase;d=string.digits;s='!@#%^*-_=+';p=[secrets.choice(a),secrets.choice(b),secrets.choice(d),secrets.choice(s)]+[secrets.choice(a+b+d+s) for _ in range(20)];random.shuffle(p);print(''.join(p))")

# create only if missing; otherwise just reset the password
P cognito-idp admin-create-user --user-pool-id "$POOL" --username "$USER" \
  --user-attributes Name=email,Value="$USER" Name=email_verified,Value=true Name=name,Value="Synthetic Monitor" \
  --message-action SUPPRESS || true
P cognito-idp admin-set-user-password --user-pool-id "$POOL" --username "$USER" --password "$PW" --permanent
P cognito-idp admin-add-user-to-group --user-pool-id "$POOL" --username "$USER" --group-name admin

P ssm put-parameter --name /k8s/development/synthetic-monitor/username        --type String       --overwrite --value "$USER"
P ssm put-parameter --name /k8s/development/synthetic-monitor/password        --type SecureString --overwrite --value "$PW"
P ssm put-parameter --name /k8s/development/synthetic-monitor/cognito-client-id --type String     --overwrite --value "$CLIENT"
```

Verify the flow works (should return an IdToken):

```bash
PW=$(aws ssm get-parameter --profile dev-account --region eu-west-1 \
  --name /k8s/development/synthetic-monitor/password --with-decryption --query Parameter.Value --output text)
aws cognito-idp initiate-auth --profile dev-account --region eu-west-1 \
  --client-id 3jtefdlkq4ipg7mlrkhprmob06 --auth-flow USER_PASSWORD_AUTH \
  --auth-parameters USERNAME=synthetic-monitor@noreply.nelsonlamounier.com,PASSWORD="$PW" \
  --query 'AuthenticationResult.IdToken!=null'
```

After rotating, restart the ExternalSecret sync or wait one refresh interval
(1h) for `synthetic-monitor-secret` to pick up the new value.

---

## 2. Resume fixture ConfigMap  ⬜ required before enabling

The probe uploads a real PDF (mounted at `/fixtures/sample-resume.pdf`). It is
**not** baked into the image so it can be rotated without a rebuild. Use a
small, text-extractable resume PDF (avoids the Textract fallback path).

```bash
kubectl -n monitoring create configmap synthetic-resume-fixture \
  --from-file=sample-resume.pdf=./fixtures/sample-resume.pdf
```

---

## 3. Enable + ordering  ⬜

`syntheticMonitor.enabled` is `false` by default and `true` in
`values-development.yaml`. The CronJob only works once the image exists, so
follow this order:

1. Merge **cdk-monitoring** ECR PR → deploy the shared-infra stack (creates the
   ECR repo + `/shared/ecr-synthetic-monitor/development/repository-uri`).
2. Merge **ai-applications** PR → `deploy-synthetic-monitor.yml` builds + pushes
   the first image tag.
3. Merge **kubernetes-bootstrap** PR → ArgoCD Image Updater writes that tag into
   `syntheticMonitor.image.tag`; ArgoCD rolls the CronJob.
4. Create the fixture ConfigMap (step 2 above).

Confirm it is running:

```bash
kubectl -n monitoring get cronjob synthetic-monitor
kubectl -n monitoring logs -l app=synthetic-monitor --tail=50   # JSON: event=synthetic_check
# in Grafana Explore (Prometheus):  synthetic_check_success
```

If `SyntheticCheckAbsent` fires, the CronJob is not scheduling or cannot push to
Pushgateway; if `SyntheticCheckFailing` fires, inspect the JSON `reason` in the
pod logs.
