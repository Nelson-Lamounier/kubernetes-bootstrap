# Golden AMI & EBS Lifecycle — Troubleshooting Runbook

> **Purpose**: Diagnose Golden AMI pipeline failures, cloud-init breakage,
> EBS detachment timeouts, and ASG update hangs.

**Last Updated:** 2026-03-25
**Operator:** Solo — infrastructure owner

---

## CloudWatch Log Groups Reference

All log groups use the `k8s` name prefix (configurable via `namePrefix`
prop in CDK stacks). Replace `<env>` with `development`, `staging`, or
`production`.

### Compute & Instance Logs

| Log Group | Source | Content |
| :--- | :--- | :--- |
| `/ec2/k8s/instances` | CloudWatch Agent (user-data) | Instance bootstrap stdout/stderr, cloud-init output, cfn-signal result |

### Lambda Function Logs

| Log Group | Source | Content |
| :--- | :--- | :--- |
| `/aws/lambda/k8s-ebs-detach-lifecycle` | EBS Detach Lifecycle Lambda | Volume detachment events, lifecycle hook completion, error traces |

### SSM Automation Logs

| Log Group | Source | Content |
| :--- | :--- | :--- |
| `/ssm/k8s/<env>/bootstrap` | SSM Automation (bootstrap doc) | Step-by-step bootstrap output for control-plane and worker nodes |
| `/ssm/k8s/<env>/deploy` | SSM Automation (deploy doc) | Application deployment script output (secrets, ArgoCD config) |
| `/ssm/k8s/<env>/drift` | SSM Automation (drift enforcement) | Node drift detection and remediation output |

### Image Builder Logs

| Log Group | Source | Content |
| :--- | :--- | :--- |
| `/aws/imagebuilder/k8s-dev-golden-ami` | EC2 Image Builder | AMI bake execution logs |
| `/aws/imagebuilder/k8s-dev-golden-ami-recipe` | EC2 Image Builder | Recipe-level install and validate phase output |

> [!TIP]
> Image Builder logs are created automatically by the service. Search for
> log groups starting with `/aws/imagebuilder/` to find the active pipeline.

---

## Quick Diagnostics (`just` commands)

All diagnostic commands below are defined in the project `justfile` and
require no manual AWS CLI invocations.

### 1. Fetch Cloud-Init Log from an Instance

Retrieves `/var/log/cloud-init-output.log` via SSM and saves a local
copy under `scripts/local/diagnostics/.troubleshoot-logs/`.

```bash
# Fetch the last 200 lines (default)
just cloud-init-log <instance-id>

# Fetch the last 500 lines, staging environment
just cloud-init-log <instance-id> staging eu-west-1 500
```

### 2. Audit EBS Volume Lifecycle

Shows the full attach/detach event timeline for a volume, including
CloudTrail correlation and ASG lifecycle hook status.

```bash
# Basic audit
just ebs-lifecycle <volume-id>

# With ASG context
just ebs-lifecycle <volume-id> development --stack ControlPlane-development \
  --asg-logical-id ComputeAutoScalingGroupASG7021CF69
```

### 3. Audit CloudWatch Log Groups

Identifies empty, stale, and unmanaged log groups — useful after stack
teardowns or to verify log groups are populating.

```bash
just cw-log-audit development
```

### 4. Troubleshoot CloudFormation Stack Deployments

Diagnoses slow, stuck, or failed stack operations — including ASG
`UPDATE_IN_PROGRESS` hangs.

```bash
just cfn-troubleshoot ControlPlane-development development
```

### 5. SSM Bootstrap Status & Logs

Shows recent SSM Automation execution status and per-step output.

```bash
# View last 3 executions
just ssm-bootstrap-status

# View last 5 executions
just ssm-bootstrap-status 5

# Read step stdout/stderr (last 100 lines, control-plane doc)
just ssm-bootstrap-logs 100 development control-plane
```

### 6. Validate AMI Build Component YAML (no AWS calls)

Runs 17 unit tests that statically analyse the generated component YAML
for anti-patterns (e.g. `alternatives --set python3`).

```bash
just test-ami-build
```

### 7. Connect to Cluster

```bash
# Auto-discover instance and start SSM tunnel
just k8s-tunnel-auto

# Check cloud-init on the node
cloud-init status --long
```

---

## Common Failure Scenarios

### Scenario 1: ASG Stuck on `UPDATE_IN_PROGRESS` — cfn-signal Never Received

**Symptoms:**

- CloudFormation shows `UPDATE_IN_PROGRESS` on the ASG for >15 minutes
- Instance is running but `cloud-init status` shows `error` or `degraded`

**Diagnosis:**

```bash
# 1. Diagnose the stuck CFN stack
just cfn-troubleshoot ControlPlane-development development

# 2. Fetch cloud-init log from the new instance
just cloud-init-log <instance-id>

# 3. Check instance log group
just cw-log-audit development
```

**Root Cause:** cloud-init failed, so user-data never completed and
`cfn-signal` was never sent.

**Resolution:**

- If caused by Python version issue: the virtualenv fix in
  `build-golden-ami-component.ts` resolves this — re-bake the AMI
- If caused by missing packages: check the Image Builder validate phase logs
- Validate the component YAML locally: `just test-ami-build`

### Scenario 2: EBS Volume Not Detached on Instance Replacement

**Symptoms:**

- Old EBS volume stuck in `in-use` state after instance termination
- New instance cannot attach the volume

**Diagnosis:**

```bash
# 1. Audit the full volume lifecycle
just ebs-lifecycle <volume-id>

# 2. Check Lambda logs for detachment events
aws logs tail "/aws/lambda/k8s-ebs-detach-lifecycle" \
  --since 1h --format short \
  --region eu-west-1 --profile dev-account
```

**Resolution:**

- If Lambda didn't fire: check EventBridge rule in the console
  (`k8s-ebs-detach-rule`)
- If Lambda errored: check the error trace in the Lambda log group
- Manual force-detach as last resort:
  ```bash
  aws ec2 detach-volume --volume-id <vol-id> --force \
    --region eu-west-1 --profile dev-account
  ```

### Scenario 3: Golden AMI Bake Fails — Validate Phase

**Symptoms:**

- Image Builder pipeline shows `FAILED` status
- AMI SSM parameter not updated

**Diagnosis:**

```bash
# 1. Run local static analysis to catch YAML anti-patterns
just test-ami-build

# 2. Discover Image Builder log groups
aws logs describe-log-groups \
  --log-group-name-prefix "/aws/imagebuilder/" \
  --query "logGroups[*].logGroupName" --output table \
  --region eu-west-1 --profile dev-account

# Known log groups:
#   /aws/imagebuilder/k8s-dev-golden-ami
#   /aws/imagebuilder/k8s-dev-golden-ami-recipe

# 3. Query the specific log group for errors
aws logs filter-log-events \
  --log-group-name "/aws/imagebuilder/k8s-dev-golden-ami" \
  --filter-pattern "?FATAL ?ERROR ?FAIL" \
  --start-time $(date -v-2H +%s)000 \
  --region eu-west-1 --profile dev-account
```

**Resolution:**

- Fix the component YAML in `build-golden-ami-component.ts`
- Re-trigger the pipeline via CDK deploy

### Scenario 4: System Python Overridden — cloud-init Package Import Errors

**Symptoms:**

- `cloud-init status` shows `error`
- `/var/log/cloud-init.log` contains `ModuleNotFoundError`

**Root Cause:** `alternatives --set python3 python3.11` was used, which
hijacks the system Python 3.9 that cloud-init depends on.

**Diagnosis:**

```bash
# 1. Verify locally that the anti-pattern is caught
just test-ami-build

# 2. Check on the instance
just cloud-init-log <instance-id>

# 3. Or connect directly
just k8s-tunnel-auto
# Then: python3 --version  (should be 3.9, NOT 3.11)
```

**Resolution:**

The fix is already in place: the AMI now uses `/opt/k8s-venv` instead
of `alternatives`. Re-bake the AMI to pick up the fix.

---

## EventBridge Rules Reference

| Rule | Event Source | Target | Purpose |
| :--- | :--- | :--- | :--- |
| `k8s-ebs-detach-rule` | `aws.autoscaling` (EC2 Instance-terminate Lifecycle Action) | EBS Detach Lambda | Gracefully detach EBS volumes before instance termination |
| EIP Failover rule | `aws.autoscaling` (EC2 Instance Launch Successful) | EIP Failover Lambda | Auto-associate Elastic IP to new instances |

---

## Justfile Command Quick Reference

| Command | Purpose | AWS Calls? |
| :--- | :--- | :---: |
| `just cloud-init-log <id>` | Fetch cloud-init-output.log via SSM | ✅ |
| `just ebs-lifecycle <vol-id>` | Audit EBS attach/detach timeline | ✅ |
| `just cw-log-audit <env>` | Find empty/stale log groups | ✅ |
| `just cfn-troubleshoot <stack> <env>` | Diagnose stuck CFN operations | ✅ |
| `just ssm-bootstrap-status` | SSM Automation execution overview | ✅ |
| `just ssm-bootstrap-logs` | SSM step stdout/stderr | ✅ |
| `just ssm-s3-sync-status` | Verify S3 script sync timestamps | ✅ |
| `just test-ami-build` | AMI component YAML validation | ❌ |
| `just k8s-tunnel-auto` | SSM tunnel to cluster node | ✅ |

---

## Source Files

| File | Purpose |
| :--- | :--- |
| `infra/lib/stacks/kubernetes/control-plane-stack.ts` | EBS detach Lambda, EventBridge rules, instance log group |
| `infra/lib/stacks/kubernetes/golden-ami-stack.ts` | Image Builder pipeline and component configuration |
| `infra/lib/constructs/compute/utils/build-golden-ami-component.ts` | Component YAML generation (virtualenv, validate phase) |
| `infra/lib/constructs/ssm/automation-document.ts` | SSM Automation documents (PATH prepend, bootstrap steps) |
| `infra/tests/unit/constructs/compute/build-golden-ami-component.test.ts` | Unit tests — anti-pattern detection (17 checks) |

---

## Related Runbooks

- [SSM Automation — Deployment & Redeployment](./ssm-automation-deployment.md)
- [Bootstrap Deadlock — CCM Recovery](./bootstrap-deadlock-ccm.md)
- [Cross-AZ Disaster Recovery](./cross-az-recovery.md)

---

*Commands and paths above are real values from the cdk-monitoring repository.*
