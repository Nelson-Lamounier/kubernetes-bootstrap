# @format
# justfile — Task runner for kubernetes-bootstrap
#
# Usage:
#   just              List all recipes
#   just synth development
#   just deploy development
#   just ssm-run-controlplane i-0abc123def456
#
# Prerequisites:
#   brew install just
#
# This file is the single CLI entry point for local development and ops.
# CI/CD pipelines also use 'just' for code quality tasks (lint, build, typecheck).

# Default recipe — show help
default:
    @just --list --unsorted

# Shorthand alias for listing recipes
ls:
    @just --list --unsorted

# =============================================================================
# INTERNAL HELPERS
# =============================================================================

# Resolve AWS profile from environment name
[private]
_profile env:
    #!/usr/bin/env bash
    case "{{env}}" in
      development) echo "dev-account" ;;
      staging)     echo "staging-account" ;;
      production)  echo "prod-account" ;;
      *)           echo "dev-account" ;;
    esac

# Map environment to short abbreviation (matches CDK shortEnv())
[private]
_short-env env:
    #!/usr/bin/env bash
    case "{{env}}" in
      development) echo "dev" ;;
      staging)     echo "stg" ;;
      production)  echo "prd" ;;
      *)           echo "{{env}}" ;;
    esac

# =============================================================================
# CDK COMMANDS
# =============================================================================

# Synthesize CDK stacks (e.g., just synth development)
# Pass vpcId for GoldenAmiStack: just synth development vpc-xxxxxxxxx
[group('cdk')]
synth environment="development" vpc-id="" *ARGS:
    #!/usr/bin/env bash
    set -euo pipefail
    VPC_ARGS=""
    if [ -n "{{vpc-id}}" ]; then
      VPC_ARGS="-c vpcId={{vpc-id}}"
    fi
    cd infra && npx cdk synth --all \
      -c environment={{environment}} \
      ${VPC_ARGS} \
      --profile $(just _profile {{environment}}) \
      {{ARGS}}

# Deploy all CDK stacks (e.g., just deploy development)
[group('cdk')]
deploy environment="development" vpc-id="" *ARGS:
    #!/usr/bin/env bash
    set -euo pipefail
    VPC_ARGS=""
    if [ -n "{{vpc-id}}" ]; then
      VPC_ARGS="-c vpcId={{vpc-id}}"
    fi
    cd infra && npx cdk deploy --all \
      -c environment={{environment}} \
      ${VPC_ARGS} \
      --profile $(just _profile {{environment}}) \
      --require-approval never \
      {{ARGS}}

# Deploy a single CDK stack (e.g., just deploy-stack K8s-GoldenAmi-development development)
[group('cdk')]
deploy-stack stack environment="development" vpc-id="" *ARGS:
    #!/usr/bin/env bash
    set -euo pipefail
    VPC_ARGS=""
    if [ -n "{{vpc-id}}" ]; then
      VPC_ARGS="-c vpcId={{vpc-id}}"
    fi
    cd infra && npx cdk deploy {{stack}} --exclusively \
      -c environment={{environment}} \
      ${VPC_ARGS} \
      --profile $(just _profile {{environment}}) \
      --require-approval never \
      {{ARGS}}

# Show diff between local and deployed stacks
[group('cdk')]
diff environment="development" vpc-id="" *ARGS:
    #!/usr/bin/env bash
    set -euo pipefail
    VPC_ARGS=""
    if [ -n "{{vpc-id}}" ]; then
      VPC_ARGS="-c vpcId={{vpc-id}}"
    fi
    cd infra && npx cdk diff --all \
      -c environment={{environment}} \
      ${VPC_ARGS} \
      --profile $(just _profile {{environment}}) \
      {{ARGS}}

# Destroy CDK stacks
[group('cdk')]
destroy environment="development" *ARGS:
    cd infra && npx cdk destroy --all \
      -c environment={{environment}} \
      --profile $(just _profile {{environment}}) \
      {{ARGS}}

# List all CDK stacks
[group('cdk')]
list environment="development":
    cd infra && npx cdk list \
      -c environment={{environment}} \
      --profile $(just _profile {{environment}})

# Bootstrap CDK in an AWS account
[group('cdk')]
cdk-bootstrap account profile *ARGS:
    cd infra && npx cdk bootstrap aws://{{account}}/eu-west-1 \
      --profile {{profile}} \
      --qualifier hnb659fds \
      --toolkit-stack-name CDKToolkit \
      {{ARGS}}

# =============================================================================
# GOLDEN AMI
# =============================================================================

# Deploy only the GoldenAmi CDK stack — fetches VPC ID from SSM automatically
# Usage: just deploy-golden-ami-stack
#        just deploy-golden-ami-stack staging
[group('cdk')]
deploy-golden-ami-stack env="development" region="eu-west-1" profile="dev-account":
    #!/usr/bin/env bash
    set -euo pipefail
    VPC_ID=$(aws ssm get-parameter \
      --name "/k8s/{{env}}/vpc-id" \
      --region {{region}} --profile {{profile}} \
      --query Parameter.Value --output text)
    echo "→ VPC ID: ${VPC_ID}"
    just deploy-stack "K8s-GoldenAmi-{{env}}" {{env}} "${VPC_ID}"

# Trigger Golden AMI Image Builder pipeline and poll for completion
# Usage: just build-golden-ami development
#        just build-golden-ami production eu-west-1
[group('k8s')]
build-golden-ami env="development" region="eu-west-1":
    #!/usr/bin/env bash
    set -euo pipefail
    PROFILE=$(just _profile {{env}})
    STACK_NAME="K8s-GoldenAmi-{{env}}"
    NAME_PREFIX="k8s-$(just _short-env {{env}})"

    # ------------------------------------------------------------------
    # Preflight: verify all three SSM prerequisites exist before baking
    # ------------------------------------------------------------------
    echo "→ Preflight checks..."
    PREFLIGHT_FAILED=0

    for SSM_KEY in \
      "/k8s/{{env}}/vpc-id" \
      "/k8s/{{env}}/scripts-bucket" \
      "/k8s/{{env}}/security-group-id"; do
      VALUE=$(aws ssm get-parameter \
        --name "$SSM_KEY" \
        --region {{region}} --profile "${PROFILE}" \
        --query Parameter.Value --output text 2>/dev/null || echo "")
      if [ -z "$VALUE" ] || [ "$VALUE" = "None" ]; then
        echo "  ✗ Missing SSM parameter: $SSM_KEY"
        PREFLIGHT_FAILED=1
      else
        echo "  ✓ $SSM_KEY = $VALUE"
      fi
    done

    # Verify S3 has scripts (bucket must be non-empty before baking)
    BUCKET=$(aws ssm get-parameter \
      --name "/k8s/{{env}}/scripts-bucket" \
      --region {{region}} --profile "${PROFILE}" \
      --query Parameter.Value --output text 2>/dev/null || echo "")
    if [ -n "$BUCKET" ] && [ "$BUCKET" != "None" ]; then
      SCRIPT_COUNT=$(aws s3 ls "s3://${BUCKET}/k8s-bootstrap/" --recursive \
        --region {{region}} --profile "${PROFILE}" 2>/dev/null | wc -l | tr -d ' ')
      if [ "$SCRIPT_COUNT" -lt 5 ]; then
        echo "  ✗ S3 scripts bucket is empty or missing (${SCRIPT_COUNT} files) — run: just sync-k8s-bootstrap {{env}}"
        PREFLIGHT_FAILED=1
      else
        echo "  ✓ S3 scripts bucket has ${SCRIPT_COUNT} files"
      fi
    fi

    if [ "$PREFLIGHT_FAILED" = "1" ]; then
      echo ""
      echo "✗ Preflight failed. Deploy order:"
      echo "  1. just deploy-stack K8s-SsmAutomation-{{env}} {{env}}"
      echo "  2. just sync-k8s-bootstrap {{env}}"
      echo "  3. just build-golden-ami {{env}}"
      exit 1
    fi
    echo "✓ Preflight passed"
    echo ""

    echo "→ Resolving Image Builder pipeline ARN (${STACK_NAME})..."
    PIPELINE_ARN=$(aws imagebuilder list-image-pipelines \
      --filters "name=name,values=${NAME_PREFIX}-golden-ami-pipeline" \
      --query 'imagePipelineList[0].arn' \
      --output text \
      --region {{region}} --profile "${PROFILE}" 2>/dev/null || echo "")

    if [ -z "$PIPELINE_ARN" ] || [ "$PIPELINE_ARN" = "None" ]; then
      echo "  Falling back to CloudFormation resource lookup..."
      PIPELINE_ARN=$(aws cloudformation describe-stack-resources \
        --stack-name "${STACK_NAME}" \
        --region {{region}} --profile "${PROFILE}" \
        --query "StackResources[?ResourceType=='AWS::ImageBuilder::ImagePipeline'].PhysicalResourceId" \
        --output text 2>/dev/null || echo "")
    fi

    if [ -z "$PIPELINE_ARN" ] || [ "$PIPELINE_ARN" = "None" ]; then
      echo "✗ Pipeline ARN not found. Deploy the GoldenAmi stack first:"
      echo "  just deploy-stack ${STACK_NAME} {{env}}"
      exit 1
    fi

    echo "→ Starting pipeline: ${PIPELINE_ARN}"
    BUILD_VERSION=$(aws imagebuilder start-image-pipeline-execution \
      --image-pipeline-arn "${PIPELINE_ARN}" \
      --region {{region}} --profile "${PROFILE}" \
      --query 'imageBuildVersionArn' --output text)
    echo "  Build ARN: ${BUILD_VERSION}"

    echo "→ Polling SSM /k8s/{{env}}/golden-ami/latest for AMI ID..."
    MAX_WAIT=1800
    POLL=30
    ELAPSED=0
    while [ $ELAPSED -lt $MAX_WAIT ]; do
      AMI_ID=$(aws ssm get-parameter \
        --name "/k8s/{{env}}/golden-ami/latest" \
        --region {{region}} --profile "${PROFILE}" \
        --query Parameter.Value --output text 2>/dev/null || echo "")
      if [[ "$AMI_ID" == ami-* ]]; then
        STATE=$(aws ec2 describe-images \
          --image-ids "$AMI_ID" \
          --region {{region}} --profile "${PROFILE}" \
          --query 'Images[0].State' --output text 2>/dev/null || echo "unknown")
        echo "  AMI: ${AMI_ID} — state: ${STATE}"
        if [ "$STATE" = "available" ]; then
          echo "✓ Golden AMI ready: ${AMI_ID}"
          exit 0
        fi
      fi
      echo "  Waiting... (${ELAPSED}/${MAX_WAIT}s)"
      sleep $POLL
      ELAPSED=$((ELAPSED + POLL))
    done
    echo "✗ Timed out after ${MAX_WAIT}s"
    exit 1

# Dispatch any GitHub Actions workflow via gh CLI
# Requires: gh CLI authenticated (gh auth login)
# Usage: just gh-dispatch deploy-golden-ami.yml
#        just gh-dispatch deploy-golden-ami.yml --field environment=staging
#        just gh-dispatch deploy-golden-ami.yml --field existing_ami_id=ami-0abc123
[group('ci')]
gh-dispatch workflow *ARGS:
    gh workflow run {{workflow}} {{ARGS}}

# Trigger the deploy-golden-ami GitHub Actions workflow
# Requires: gh CLI authenticated (gh auth login)
# Usage: just ami-workflow production
#        just ami-workflow production build-ami=false
#        just ami-workflow production existing-ami-id=ami-0abc123
[group('ci')]
ami-workflow env="development" build-ami="true" existing-ami-id="":
    #!/usr/bin/env bash
    set -euo pipefail
    ARGS=(--field environment={{env}} --field build_ami={{build-ami}})
    if [ -n "{{existing-ami-id}}" ]; then
      ARGS+=(--field existing_ami_id={{existing-ami-id}})
    fi
    gh workflow run deploy-golden-ami.yml "${ARGS[@]}"

# Sync bootstrap scripts from boot/ to S3 (for AMI bake or emergency re-sync)
# Usage: just sync-k8s-bootstrap development dev-account
[group('k8s')]
sync-k8s-bootstrap env="development" region="eu-west-1" profile="dev-account":
    #!/usr/bin/env bash
    set -euo pipefail
    SSM_KEY="/k8s/{{env}}/scripts-bucket"
    echo "→ Looking up S3 bucket from SSM: ${SSM_KEY}"
    BUCKET=$(aws ssm get-parameter \
      --name "${SSM_KEY}" \
      --query 'Parameter.Value' --output text \
      --region {{region}} \
      --profile "{{profile}}" 2>/dev/null | sed 's|^s3://||;s|/$||')
    if [ -z "$BUCKET" ]; then
      echo "✗ SSM parameter ${SSM_KEY} not found. Has the Infra pipeline been deployed?"
      exit 1
    fi
    echo "→ Syncing boot/ → s3://${BUCKET}/k8s-bootstrap/"
    aws s3 sync boot "s3://${BUCKET}/k8s-bootstrap/" \
      --delete \
      --exclude "**/__pycache__/*" \
      --exclude "**/*.pyc" \
      --exclude "**/.venv/*" \
      --region {{region}} \
      --profile "{{profile}}"
    FILE_COUNT=$(aws s3 ls "s3://${BUCKET}/k8s-bootstrap/" --recursive --profile "{{profile}}" | wc -l | tr -d ' ')
    echo "✓ Bootstrap sync complete (${FILE_COUNT} files on S3)"

# =============================================================================
# SSM AUTOMATION — BOOTSTRAP
# =============================================================================

# Trigger SSM Automation — Control Plane bootstrap
# Runs: validateGoldenAMI → initKubeadm → installCalicoCNI → configureKubectl
#       → bootstrapArgoCD → verifyCluster
# Usage: just ssm-run-controlplane i-0f1491fd3dc63fd66
[group('k8s')]
ssm-run-controlplane instance-id env="development" region="eu-west-1" profile="dev-account":
    #!/usr/bin/env bash
    set -euo pipefail
    SHORT_ENV=$(just _short-env {{env}})
    SSM_PREFIX="/k8s/{{env}}"
    S3_BUCKET=$(aws ssm get-parameter \
      --name "${SSM_PREFIX}/scripts-bucket" \
      --query "Parameter.Value" --output text \
      --region {{region}} --profile {{profile}})
    echo "Starting control-plane bootstrap on {{instance-id}}..."
    EXEC_ID=$(aws ssm start-automation-execution \
      --document-name "k8s-${SHORT_ENV}-bootstrap-control-plane" \
      --parameters "InstanceId={{instance-id}},SsmPrefix=${SSM_PREFIX},S3Bucket=${S3_BUCKET},Region={{region}}" \
      --region {{region}} --profile {{profile}} \
      --query "AutomationExecutionId" --output text)
    echo "Execution ID: ${EXEC_ID}"
    echo "Monitor:  just ssm-status ${EXEC_ID} {{region}} {{profile}}"

# Trigger SSM Automation — Worker node bootstrap
# Runs: validateGoldenAMI → joinCluster
# Run AFTER control-plane has completed (workers need join credentials).
# Usage: just ssm-run-worker i-071c910118e0c0beb
[group('k8s')]
ssm-run-worker instance-id env="development" region="eu-west-1" profile="dev-account":
    #!/usr/bin/env bash
    set -euo pipefail
    SHORT_ENV=$(just _short-env {{env}})
    SSM_PREFIX="/k8s/{{env}}"
    S3_BUCKET=$(aws ssm get-parameter \
      --name "${SSM_PREFIX}/scripts-bucket" \
      --query "Parameter.Value" --output text \
      --region {{region}} --profile {{profile}})
    echo "Starting worker bootstrap on {{instance-id}}..."
    EXEC_ID=$(aws ssm start-automation-execution \
      --document-name "k8s-${SHORT_ENV}-bootstrap-worker" \
      --parameters "InstanceId={{instance-id}},SsmPrefix=${SSM_PREFIX},S3Bucket=${S3_BUCKET},Region={{region}}" \
      --region {{region}} --profile {{profile}} \
      --query "AutomationExecutionId" --output text)
    echo "Execution ID: ${EXEC_ID}"
    echo "Monitor:  just ssm-status ${EXEC_ID} {{region}} {{profile}}"

# Check SSM Automation execution status and step progress
# Usage: just ssm-status <execution-id>
[group('k8s')]
ssm-status execution-id region="eu-west-1" profile="dev-account":
    #!/usr/bin/env bash
    set -euo pipefail
    aws ssm get-automation-execution \
      --automation-execution-id {{execution-id}} \
      --query "AutomationExecution.{Status:AutomationExecutionStatus,Steps:StepExecutions[*].{Step:StepName,Status:StepStatus,Start:ExecutionStartTime,End:ExecutionEndTime}}" \
      --output table \
      --region {{region}} --profile {{profile}}

# List latest SSM Automation executions for all bootstrap documents
# Usage: just ssm-bootstrap-status
#        just ssm-bootstrap-status 5          # last 5 executions per doc
[group('k8s')]
ssm-bootstrap-status count="3" env="development" region="eu-west-1" profile="dev-account":
    #!/usr/bin/env bash
    set -euo pipefail
    SHORT_ENV=$(just _short-env {{env}})
    DOCS=("k8s-${SHORT_ENV}-bootstrap-control-plane" "k8s-${SHORT_ENV}-bootstrap-worker")
    for DOC in "${DOCS[@]}"; do
      echo "═══════════════════════════════════════════════════════════"
      echo "  📄  ${DOC}"
      echo "═══════════════════════════════════════════════════════════"
      echo ""
      EXEC_IDS=$(aws ssm describe-automation-executions \
        --filters "Key=DocumentNamePrefix,Values=${DOC}" \
        --max-results {{count}} \
        --query "AutomationExecutionMetadataList[*].[AutomationExecutionId,AutomationExecutionStatus,ExecutionStartTime,ExecutionEndTime]" \
        --output text \
        --region {{region}} --profile {{profile}} 2>/dev/null || echo "")
      if [ -z "$EXEC_IDS" ]; then
        echo "  (no executions found)"
        echo ""
        continue
      fi
      while IFS=$'\t' read -r EXEC_ID STATUS START END; do
        echo "  ▸ ${EXEC_ID}"
        echo "    Status: ${STATUS}  |  Start: ${START}  |  End: ${END:-—}"
        echo "    Steps:"
        aws ssm get-automation-execution \
          --automation-execution-id "${EXEC_ID}" \
          --query "AutomationExecution.StepExecutions[*].[StepName,StepStatus]" \
          --output text \
          --region {{region}} --profile {{profile}} 2>/dev/null | \
          while IFS=$'\t' read -r STEP_NAME STEP_STATUS; do
            case "${STEP_STATUS}" in
              Success)    ICON="✅" ;;
              Failed)     ICON="❌" ;;
              InProgress) ICON="🔄" ;;
              Cancelled)  ICON="⛔" ;;
              TimedOut)   ICON="⏰" ;;
              *)          ICON="⬜" ;;
            esac
            printf "      %s  %-40s %s\n" "${ICON}" "${STEP_NAME}" "${STEP_STATUS}"
          done
        echo ""
      done <<< "$EXEC_IDS"
    done

# Retrieve stdout/stderr logs for each step of the latest SSM Automation bootstrap execution
# Usage: just ssm-bootstrap-logs
#        just ssm-bootstrap-logs 100                  # last 100 lines per step
#        just ssm-bootstrap-logs 50 development worker
[group('k8s')]
ssm-bootstrap-logs tail="50" env="development" doc="all" region="eu-west-1" profile="dev-account":
    #!/usr/bin/env bash
    set -euo pipefail
    SHORT_ENV=$(just _short-env {{env}})
    case "{{doc}}" in
      control-plane) DOCS=("k8s-${SHORT_ENV}-bootstrap-control-plane") ;;
      worker)        DOCS=("k8s-${SHORT_ENV}-bootstrap-worker") ;;
      *)             DOCS=("k8s-${SHORT_ENV}-bootstrap-control-plane" "k8s-${SHORT_ENV}-bootstrap-worker") ;;
    esac
    for DOC in "${DOCS[@]}"; do
      echo ""
      echo "╔═══════════════════════════════════════════════════════════╗"
      echo "║  📄  ${DOC}"
      echo "╚═══════════════════════════════════════════════════════════╝"
      echo ""
      LATEST=$(aws ssm describe-automation-executions \
        --filters "Key=DocumentNamePrefix,Values=${DOC}" \
        --max-results 1 \
        --query "AutomationExecutionMetadataList[0].AutomationExecutionId" \
        --output text \
        --region {{region}} --profile {{profile}} 2>/dev/null || echo "None")
      if [ "$LATEST" = "None" ] || [ -z "$LATEST" ]; then
        echo "  (no executions found)"
        continue
      fi
      echo "  Execution: ${LATEST}"
      echo ""
      STEPS_JSON=$(aws ssm get-automation-execution \
        --automation-execution-id "${LATEST}" \
        --query "AutomationExecution.StepExecutions[*].{Name:StepName,Status:StepStatus,Outputs:Outputs}" \
        --output json \
        --region {{region}} --profile {{profile}} 2>/dev/null)
      STEP_COUNT=$(echo "$STEPS_JSON" | python3 -c "import sys,json; print(len(json.load(sys.stdin)))" 2>/dev/null || echo "0")
      if [ "$STEP_COUNT" = "0" ]; then
        echo "  (no steps found)"
        continue
      fi
      for i in $(seq 0 $(( STEP_COUNT - 1 ))); do
        STEP_NAME=$(echo "$STEPS_JSON" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d[$i]['Name'])")
        STEP_STATUS=$(echo "$STEPS_JSON" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d[$i]['Status'])")
        COMMAND_ID=$(echo "$STEPS_JSON" | python3 -c "
    import sys, json
    d = json.load(sys.stdin)
    outputs = d[$i].get('Outputs', {})
    cmd_id = outputs.get('CommandId', [''])[0] if outputs else ''
    print(cmd_id)
    " 2>/dev/null || echo "")
        case "${STEP_STATUS}" in
          Success)    ICON="✅" ;;
          Failed)     ICON="❌" ;;
          InProgress) ICON="🔄" ;;
          Cancelled)  ICON="⛔" ;;
          TimedOut)   ICON="⏰" ;;
          *)          ICON="⬜" ;;
        esac
        echo "  ┌─────────────────────────────────────────────────────────"
        printf "  │ %s  %-40s %s\n" "${ICON}" "${STEP_NAME}" "${STEP_STATUS}"
        echo "  └─────────────────────────────────────────────────────────"
        if [ -z "$COMMAND_ID" ]; then
          echo "    (no command output available — step may not have executed)"
          echo ""
          continue
        fi
        INSTANCE_ID=$(aws ssm get-automation-execution \
          --automation-execution-id "${LATEST}" \
          --query "AutomationExecution.Parameters.InstanceId[0]" \
          --output text \
          --region {{region}} --profile {{profile}} 2>/dev/null || echo "")
        if [ -z "$INSTANCE_ID" ] || [ "$INSTANCE_ID" = "None" ]; then
          echo "    (could not resolve instance ID)"
          echo ""
          continue
        fi
        OUTPUT_JSON=$(aws ssm get-command-invocation \
          --command-id "${COMMAND_ID}" \
          --instance-id "${INSTANCE_ID}" \
          --query "{Status:Status,Stdout:StandardOutputContent,Stderr:StandardErrorContent}" \
          --output json \
          --region {{region}} --profile {{profile}} 2>/dev/null || echo '{"Status":"NotFound","Stdout":"","Stderr":""}')
        STDOUT=$(echo "$OUTPUT_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin).get('Stdout',''))" 2>/dev/null || echo "")
        STDERR=$(echo "$OUTPUT_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin).get('Stderr',''))" 2>/dev/null || echo "")
        if [ -n "$STDOUT" ]; then
          echo "    ── stdout (last {{tail}} lines) ──"
          echo "$STDOUT" | tail -n {{tail}} | sed 's/^/    /'
        fi
        if [ -n "$STDERR" ]; then
          echo "    ── stderr (last {{tail}} lines) ──"
          echo "$STDERR" | tail -n {{tail}} | sed 's/^/    /'
        fi
        if [ -z "$STDOUT" ] && [ -z "$STDERR" ]; then
          echo "    (output empty — check CloudWatch log group /ssm/k8s/{{env}}/bootstrap)"
        fi
        echo ""
      done
    done

# =============================================================================
# BOOT TESTING — Run bootstrap directly on live instances
# =============================================================================

# Run control plane bootstrap on a live instance via SSM RunCommand
# Scripts are baked into the AMI at /opt/k8s-bootstrap/ — no S3 sync needed.
# Usage: just boot-test-cp i-0f1491fd3dc63fd66
[group('k8s')]
boot-test-cp instance-id env="development" region="eu-west-1" profile="dev-account":
    #!/usr/bin/env bash
    set -euo pipefail
    LOG_DIR="logs"
    mkdir -p "${LOG_DIR}"
    TIMESTAMP=$(date -u +"%Y%m%dT%H%M%SZ")
    LOG_FILE="${LOG_DIR}/boot-cp-${TIMESTAMP}.log"
    echo "🚀 Running control plane bootstrap on {{instance-id}}..."
    echo "   ⚠ This will apply real changes to the instance!"
    echo "   📄 Log: ${LOG_FILE}"
    echo ""
    {
      echo "=== Control Plane Bootstrap Run ==="
      echo "Instance:    {{instance-id}}"
      echo "Environment: {{env}}"
      echo "Region:      {{region}}"
      echo "Timestamp:   ${TIMESTAMP}"
      echo ""
    } | tee "${LOG_FILE}"
    COMMAND_ID=$(aws ssm send-command \
      --instance-ids "{{instance-id}}" \
      --document-name "AWS-RunShellScript" \
      --parameters "commands=['source /etc/profile.d/k8s-env.sh 2>/dev/null || true && export PATH=/opt/k8s-venv/bin:\$PATH && python3 /opt/k8s-bootstrap/boot/steps/orchestrator.py --mode control-plane']" \
      --timeout-seconds 1800 \
      --region {{region}} --profile {{profile}} \
      --query "Command.CommandId" --output text)
    echo "  Command ID: ${COMMAND_ID}" | tee -a "${LOG_FILE}"
    echo "  Waiting for completion (up to 30 min)..." | tee -a "${LOG_FILE}"
    aws ssm wait command-executed \
      --command-id "${COMMAND_ID}" \
      --instance-id "{{instance-id}}" \
      --region {{region}} --profile {{profile}} 2>/dev/null || true
    aws ssm get-command-invocation \
      --command-id "${COMMAND_ID}" \
      --instance-id "{{instance-id}}" \
      --query "{Status:Status,Output:StandardOutputContent,Error:StandardErrorContent}" \
      --output yaml \
      --region {{region}} --profile {{profile}} | tee -a "${LOG_FILE}"
    echo ""
    echo "✅ Log saved to: ${LOG_FILE}"

# Run worker bootstrap on a live instance via SSM RunCommand
# Run AFTER control plane has completed (worker needs join credentials).
# Usage: just boot-test-worker i-071c910118e0c0beb
[group('k8s')]
boot-test-worker instance-id env="development" region="eu-west-1" profile="dev-account":
    #!/usr/bin/env bash
    set -euo pipefail
    LOG_DIR="logs"
    mkdir -p "${LOG_DIR}"
    TIMESTAMP=$(date -u +"%Y%m%dT%H%M%SZ")
    LOG_FILE="${LOG_DIR}/boot-worker-${TIMESTAMP}.log"
    echo "🚀 Running worker bootstrap on {{instance-id}}..."
    echo "   ⚠ This will apply real changes to the instance!"
    echo "   📄 Log: ${LOG_FILE}"
    echo ""
    {
      echo "=== Worker Bootstrap Run ==="
      echo "Instance:    {{instance-id}}"
      echo "Environment: {{env}}"
      echo "Region:      {{region}}"
      echo "Timestamp:   ${TIMESTAMP}"
      echo ""
    } | tee "${LOG_FILE}"
    COMMAND_ID=$(aws ssm send-command \
      --instance-ids "{{instance-id}}" \
      --document-name "AWS-RunShellScript" \
      --parameters "commands=['source /etc/profile.d/k8s-env.sh 2>/dev/null || true && export PATH=/opt/k8s-venv/bin:\$PATH && python3 /opt/k8s-bootstrap/boot/steps/orchestrator.py --mode worker']" \
      --timeout-seconds 600 \
      --region {{region}} --profile {{profile}} \
      --query "Command.CommandId" --output text)
    echo "  Command ID: ${COMMAND_ID}" | tee -a "${LOG_FILE}"
    echo "  Waiting for completion (up to 10 min)..." | tee -a "${LOG_FILE}"
    aws ssm wait command-executed \
      --command-id "${COMMAND_ID}" \
      --instance-id "{{instance-id}}" \
      --region {{region}} --profile {{profile}} 2>/dev/null || true
    aws ssm get-command-invocation \
      --command-id "${COMMAND_ID}" \
      --instance-id "{{instance-id}}" \
      --query "{Status:Status,Output:StandardOutputContent,Error:StandardErrorContent}" \
      --output yaml \
      --region {{region}} --profile {{profile}} | tee -a "${LOG_FILE}"
    echo ""
    echo "✅ Log saved to: ${LOG_FILE}"

# Full boot live test workflow: sync → run bootstrap (all-in-one)
# Usage: just boot-test-live i-0f1491fd3dc63fd66            (control plane)
# Usage: just boot-test-live i-071c910118e0c0beb worker     (worker)
[group('k8s')]
boot-test-live instance-id node="cp" env="development" region="eu-west-1" profile="dev-account":
    #!/usr/bin/env bash
    set -euo pipefail
    echo "═══════════════════════════════════════════════════════════"
    echo "  🔄  Boot Live Test Workflow"
    echo "  Instance: {{instance-id}}"
    echo "  Node:     {{node}}"
    echo "  Environment: {{env}}"
    echo "═══════════════════════════════════════════════════════════"
    echo ""
    echo "── Step 1/2: Sync scripts to S3 ──"
    just sync-k8s-bootstrap {{env}} {{region}} {{profile}}
    echo ""
    echo "── Step 2/2: Run bootstrap ({{node}}) ──"
    if [[ "{{node}}" == "worker" ]]; then
      just boot-test-worker {{instance-id}} {{env}} {{region}} {{profile}}
    else
      just boot-test-cp {{instance-id}} {{env}} {{region}} {{profile}}
    fi
    echo ""
    echo "═══════════════════════════════════════════════════════════"
    echo "  ✅  Boot live test complete!"
    echo "═══════════════════════════════════════════════════════════"

# Fetch EC2 boot logs from CloudWatch (last N minutes)
# Usage: just fetch-boot-logs development
#        just fetch-boot-logs development --minutes 30
[group('k8s')]
fetch-boot-logs env="development" *ARGS:
    npx tsx scripts/fetch-boot-logs.ts {{env}} {{ARGS}}

# =============================================================================
# SSM OPERATIONS
# =============================================================================

# Open an interactive SSM root shell on the control plane (or a specific instance)
# Usage: just ssm-shell
#        just ssm-shell development i-0abc123def456
[group('ops')]
ssm-shell env="development" instance-id="" region="eu-west-1" profile="dev-account":
    #!/usr/bin/env bash
    set -exo pipefail
    export HOME="${HOME:-/root}"
    SSM_PREFIX="/k8s/{{env}}"
    if [ -z "{{instance-id}}" ]; then
      INSTANCE_ID=$(aws ssm get-parameter \
        --name "${SSM_PREFIX}/bootstrap/control-plane-instance-id" \
        --region {{region}} --profile {{profile}} \
        --query "Parameter.Value" --output text 2>/dev/null || echo "")
    else
      INSTANCE_ID="{{instance-id}}"
    fi
    if [ -z "${INSTANCE_ID}" ] || [ "${INSTANCE_ID}" = "None" ]; then
      echo "✗ Could not resolve instance ID. Is the cluster running?"
      exit 1
    fi
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "  SSM Root Shell → ${INSTANCE_ID}  ({{env}})"
    echo "  Python: /opt/k8s-venv/bin/python3"
    echo "  Bootstrap scripts: /opt/k8s-bootstrap/"
    echo "  Ctrl-D to exit"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    aws ssm start-session \
      --target "${INSTANCE_ID}" \
      --document-name AWS-StartInteractiveCommand \
      --parameters '{"command":["sudo su -"]}' \
      --region {{region}} --profile {{profile}}

# Open a plain SSM session to an EC2 instance
[group('ops')]
ec2-session instance-id profile="dev-account":
    aws ssm start-session --target {{instance-id}} --profile {{profile}}

# Run ssm-deploy.ts — trigger app deploy.py via SSM Run Command
# Usage: just ssm-deploy admin-api
#        just ssm-deploy public-api development
[group('ops')]
ssm-deploy app env="development" region="eu-west-1" *ARGS:
    npx tsx scripts/ssm-deploy.ts \
      --app {{app}} \
      --environment {{env}} \
      --region {{region}} \
      {{ARGS}}

# =============================================================================
# CLUSTER ACCESS
# =============================================================================

# Port-forward K8s API server (6443) via SSM tunnel
# Requires: local ~/.kube/config with server: https://127.0.0.1:6443
# Usage: just k8s-tunnel i-046a1035c0d593dc7
[group('k8s')]
k8s-tunnel instance-id region="eu-west-1" profile="dev-account":
    aws ssm start-session \
      --target {{instance-id}} \
      --document-name AWS-StartPortForwardingSession \
      --parameters '{"portNumber":["6443"],"localPortNumber":["6443"]}' \
      --region {{region}} --profile {{profile}}

# Port-forward K8s API server — auto-resolves control plane instance ID from SSM
# Usage: just k8s-tunnel-auto
[group('k8s')]
k8s-tunnel-auto env="development" region="eu-west-1" profile="dev-account":
    #!/usr/bin/env bash
    set -euo pipefail
    INSTANCE_ID=$(aws ssm get-parameter \
      --name "/k8s/{{env}}/bootstrap/control-plane-instance-id" \
      --query "Parameter.Value" --output text \
      --region {{region}} --profile {{profile}})
    echo "→ Control plane instance: ${INSTANCE_ID}"
    echo "→ Opening tunnel to K8s API (port 6443)…"
    aws ssm start-session \
      --target "${INSTANCE_ID}" \
      --document-name AWS-StartPortForwardingSession \
      --parameters '{"portNumber":["6443"],"localPortNumber":["6443"]}' \
      --region {{region}} --profile {{profile}}

# Fetch kubeconfig from SSM and write to ~/.kube/config
# The control plane bootstrap stores a tunnel-ready kubeconfig in SSM
# after every kubeadm init (server address rewritten to 127.0.0.1:6443).
# Usage: just k8s-fetch-kubeconfig
[group('k8s')]
k8s-fetch-kubeconfig env="development" region="eu-west-1" profile="dev-account":
    #!/usr/bin/env bash
    set -euo pipefail
    SSM_PATH="/k8s/{{env}}/kubeconfig"
    echo "→ Fetching kubeconfig from SSM: ${SSM_PATH}"
    KUBECONFIG_CONTENT=$(aws ssm get-parameter \
      --name "${SSM_PATH}" \
      --with-decryption \
      --query "Parameter.Value" --output text \
      --region {{region}} --profile {{profile}} 2>/dev/null || echo "")
    if [ -z "$KUBECONFIG_CONTENT" ]; then
      echo "✗ SSM parameter ${SSM_PATH} not found."
      echo "  The control plane bootstrap publishes this after kubeadm init."
      echo "  If the cluster was just rebuilt, wait for the bootstrap to complete."
      exit 1
    fi
    KUBE_DIR="$HOME/.kube"
    mkdir -p "$KUBE_DIR"
    if [ -f "$KUBE_DIR/config" ]; then
      BACKUP="$KUBE_DIR/config.backup.$(date +%Y%m%d%H%M%S)"
      cp "$KUBE_DIR/config" "$BACKUP"
      echo "→ Backed up existing config → $BACKUP"
    fi
    echo "$KUBECONFIG_CONTENT" > "$KUBE_DIR/config"
    chmod 600 "$KUBE_DIR/config"
    echo "✓ Kubeconfig written to $KUBE_DIR/config"
    echo ""
    echo "→ Validating connectivity (requires active SSM tunnel)…"
    if kubectl get nodes 2>/dev/null; then
      echo ""
      echo "✓ Cluster access restored successfully"
    else
      echo ""
      echo "⚠ kubectl failed — ensure the SSM tunnel is active:"
      echo "  just k8s-tunnel-auto"
    fi

# =============================================================================
# CLUSTER HEALTH & OPERATIONS
# =============================================================================

# Check cluster health (requires active SSM tunnel)
[group('k8s')]
cluster-health:
    #!/usr/bin/env bash
    set -euo pipefail
    echo "=== Node Status ==="
    kubectl get nodes -o wide
    echo ""
    echo "=== System Pods ==="
    kubectl get pods -n kube-system
    echo ""
    echo "=== ArgoCD Apps ==="
    kubectl get applications -n argocd 2>/dev/null || echo "  (ArgoCD not installed)"
    echo ""
    echo "=== Component Status ==="
    kubectl get cs 2>/dev/null || true

# Trigger an ad-hoc etcd backup via SSM Run Command
# Backup → s3://<scripts-bucket>/dr-backups/etcd/<timestamp>.db
# Usage: just k8s-etcd-backup
[group('k8s')]
k8s-etcd-backup env="development" region="eu-west-1" profile="dev-account":
    #!/usr/bin/env bash
    set -euo pipefail
    SSM_PREFIX="/k8s/{{env}}"
    INSTANCE_ID=$(aws ssm get-parameter \
      --name "${SSM_PREFIX}/bootstrap/control-plane-instance-id" \
      --region {{region}} --profile {{profile}} \
      --query 'Parameter.Value' --output text 2>/dev/null || true)
    if [[ -z "${INSTANCE_ID}" ]]; then
      echo "✗ Could not resolve control plane instance ID from SSM"
      exit 1
    fi
    echo "Triggering etcd backup on ${INSTANCE_ID}..."
    COMMAND_ID=$(aws ssm send-command \
      --instance-ids "${INSTANCE_ID}" \
      --document-name "AWS-RunShellScript" \
      --parameters 'commands=["sudo /usr/local/bin/etcd-backup.sh"]' \
      --region {{region}} --profile {{profile}} \
      --query 'Command.CommandId' --output text)
    echo "SSM Command: ${COMMAND_ID}"
    echo "Waiting for completion..."
    aws ssm wait command-executed \
      --command-id "${COMMAND_ID}" \
      --instance-id "${INSTANCE_ID}" \
      --region {{region}} --profile {{profile}} 2>/dev/null || true
    aws ssm get-command-invocation \
      --command-id "${COMMAND_ID}" \
      --instance-id "${INSTANCE_ID}" \
      --region {{region}} --profile {{profile}} \
      --query '[Status, StandardOutputContent]' --output text

# Diagnose K8s cluster issues with AI (requires k8sgpt CLI + Bedrock auth)
# Setup: k8sgpt auth add --backend amazonbedrock --model eu.anthropic.claude-sonnet-4-20250514-v1:0 --providerRegion eu-central-1
[group('k8s')]
k8s-diagnose environment="development":
    AWS_PROFILE=$(just _profile {{environment}}) k8sgpt analyze --explain --backend amazonbedrock

# Diagnose K8s cluster issues without AI
[group('k8s')]
k8s-diagnose-raw:
    k8sgpt analyze

# =============================================================================
# EC2 OPERATIONS
# =============================================================================

# List all running EC2 instances with private IP and SourceDestCheck
[group('ops')]
ec2-list-instances region="eu-west-1" profile="dev-account":
    aws ec2 describe-instances \
      --filters "Name=instance-state-name,Values=running" \
      --query 'Reservations[].Instances[].[InstanceId,PrivateIpAddress,Tags[?Key==`Name`].Value|[0],NetworkInterfaces[0].SourceDestCheck]' \
      --output table \
      --region {{region}} \
      --profile {{profile}}

# Check SourceDestCheck status on all K8s compute instances
# Must be false for Calico pod networking.
[group('ops')]
k8s-check-source-dest region="eu-west-1" profile="dev-account":
    aws ec2 describe-instances \
      --filters \
        "Name=tag:k8s:bootstrap-role,Values=control-plane,worker" \
        "Name=instance-state-name,Values=running" \
      --query 'Reservations[].Instances[].[InstanceId,Tags[?Key==`Name`].Value|[0],NetworkInterfaces[0].SourceDestCheck]' \
      --output table \
      --region {{region}} \
      --profile {{profile}}

# Disable SourceDestCheck on a specific EC2 instance
# Required for Kubernetes pod networking (Calico VXLAN encapsulation).
# Usage: just ec2-disable-source-dest-check i-069286d4c9098608b
[group('ops')]
ec2-disable-source-dest-check instance-id region="eu-west-1" profile="dev-account":
    aws ec2 modify-instance-attribute \
      --instance-id {{instance-id}} \
      --no-source-dest-check \
      --region {{region}} \
      --profile {{profile}}

# =============================================================================
# TESTING
# =============================================================================

# Troubleshoot the Golden AMI pipeline — during creation, after creation, and ASG readiness
# Runs all three phases by default.
# Usage: just troubleshoot-ami                          # all phases
#        just troubleshoot-ami --mode during            # Image Builder logs (last 30 min)
#        just troubleshoot-ami --mode during --follow   # tail logs live during a build
#        just troubleshoot-ami --mode after             # SSM parameter + AMI state
#        just troubleshoot-ami --mode asg               # launch template check
#        just troubleshoot-ami --env production --profile prod-account
[group('k8s')]
troubleshoot-ami *ARGS:
    npx tsx scripts/troubleshoot-ami.ts \
      --env development \
      --region eu-west-1 \
      --profile dev-account \
      {{ARGS}}

# Static analysis of the AMI component YAML — no AWS calls needed
# Catches anti-patterns (alternatives --set python3, missing binaries, etc.)
# Run before triggering the Image Builder pipeline.
# Usage: just test-ami-build
[group('quality')]
test-ami-build:
    npx tsx scripts/test-ami-build.ts

# =============================================================================
# CODE QUALITY
# =============================================================================

# Run ESLint (infra workspace)
[group('quality')]
lint:
    cd infra && yarn lint

# Run ESLint with auto-fix
[group('quality')]
lint-fix:
    cd infra && yarn lint:fix

# TypeScript type checking — all workspaces
[group('quality')]
typecheck:
    yarn typecheck

# Build TypeScript — all workspaces
[group('quality')]
build:
    yarn build

# Synthesize CDK and verify it compiles cleanly
[group('quality')]
synth-check environment="development":
    cd infra && npx cdk synth --all \
      -c environment={{environment}} \
      --profile $(just _profile {{environment}}) \
      --quiet

# =============================================================================
# UTILITIES
# =============================================================================

# Install dependencies (all workspaces)
[group('util')]
install:
    yarn install

# Clean build artifacts
[group('util')]
clean:
    rm -rf infra/cdk.out infra/dist scripts/dist .cache

# Clean build artifacts and reinstall
[group('util')]
reset:
    just clean
    yarn install

# Delete log files
[group('util')]
clean-logs:
    find . -name "*.log" -not -path "./.git/*" -not -path "./node_modules/*" -not -path "./infra/cdk.out/*" -delete
    echo "✓ Log files removed"

# Remove Python cache files
[group('util')]
clean-pycache:
    find . -type d -name "__pycache__" -not -path "./.git/*" -exec rm -rf {} + 2>/dev/null || true
    find . -name "*.pyc" -not -path "./.git/*" -delete 2>/dev/null || true
    echo "✓ Python cache removed"

# Preview untracked files that would be removed (dry run)
[group('util')]
clean-untracked:
    git clean -fd --dry-run

# Remove all untracked files and directories
[group('util')]
clean-untracked-force:
    git clean -fd
