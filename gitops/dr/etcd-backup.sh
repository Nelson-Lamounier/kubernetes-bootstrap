#!/usr/bin/env bash
# @format
# etcd Backup — Snapshot to S3
#
# Creates an etcd snapshot using etcdctl and uploads it to S3 with
# server-side encryption. Designed to run as a systemd timer (hourly)
# or ad-hoc via SSM Run Command.
#
# S3 path: s3://<bucket>/dr-backups/etcd/<timestamp>.db
#
# Prerequisites:
#   - etcdctl available (baked into Golden AMI or via kubeadm container)
#   - /etc/kubernetes/pki/etcd/ certificates present
#   - /etc/profile.d/k8s-env.sh sourced (provides S3_BUCKET, AWS_REGION)
#
# Exit codes:
#   0 — backup succeeded
#   1 — backup failed (logged for CloudWatch)

set -euo pipefail

# ─── Configuration ────────────────────────────────────────────────────
SCRIPT_NAME="etcd-backup"
TIMESTAMP=$(date +%Y%m%d-%H%M%S)

# Use /var/lib/etcd/snapshots/ — this path is host-mounted in kubeadm's
# etcd static pod, so the snapshot is visible from both the container
# (where etcdctl saves it) and the host (where stat/aws s3 cp run).
SNAPSHOT_DIR="/var/lib/etcd/snapshots"
mkdir -p "${SNAPSHOT_DIR}"
SNAPSHOT_PATH="${SNAPSHOT_DIR}/etcd-snapshot-${TIMESTAMP}.db"

# Source environment variables from bootstrap
ENV_FILE="/etc/profile.d/k8s-env.sh"
if [[ -f "${ENV_FILE}" ]]; then
    # shellcheck source=/dev/null
    source "${ENV_FILE}"
fi

S3_BUCKET="${S3_BUCKET:-}"
AWS_REGION="${AWS_REGION:-eu-west-1}"
S3_PREFIX="dr-backups/etcd"

# etcd certificate paths (kubeadm defaults)
ETCD_CACERT="/etc/kubernetes/pki/etcd/ca.crt"
ETCD_CERT="/etc/kubernetes/pki/etcd/server.crt"
ETCD_KEY="/etc/kubernetes/pki/etcd/server.key"

# ─── Logging ──────────────────────────────────────────────────────────
log() { echo "[${SCRIPT_NAME}] $(date '+%Y-%m-%d %H:%M:%S') $1"; }

# ─── Validation ───────────────────────────────────────────────────────
if [[ -z "${S3_BUCKET}" ]]; then
    log "ERROR: S3_BUCKET not set. Source ${ENV_FILE} or export S3_BUCKET."
    exit 1
fi

for cert_file in "${ETCD_CACERT}" "${ETCD_CERT}" "${ETCD_KEY}"; do
    if [[ ! -f "${cert_file}" ]]; then
        log "ERROR: Certificate not found: ${cert_file}"
        log "Is this a control plane node with kubeadm?"
        exit 1
    fi
done

# ─── Resolve etcdctl ──────────────────────────────────────────────────
# etcdctl may be available as a binary or via the etcd container.
# Uses a function wrapper to avoid word-splitting issues with container exec.
run_etcdctl() {
    if command -v etcdctl &>/dev/null; then
        etcdctl "$@"
    else
        local container_id
        container_id=$(crictl ps --name etcd -q | head -1)
        if [[ -z "${container_id}" ]]; then
            log "ERROR: etcdctl binary not found and no etcd container running"
            exit 1
        fi
        crictl exec "${container_id}" etcdctl "$@"
    fi
}

# ─── Take Snapshot ────────────────────────────────────────────────────
log "Taking etcd snapshot..."
ETCDCTL_API=3 run_etcdctl snapshot save "${SNAPSHOT_PATH}" \
    --cacert="${ETCD_CACERT}" \
    --cert="${ETCD_CERT}" \
    --key="${ETCD_KEY}" \
    --endpoints=https://127.0.0.1:2379

SNAPSHOT_SIZE=$(stat -c%s "${SNAPSHOT_PATH}")
log "Snapshot created: ${SNAPSHOT_PATH} (${SNAPSHOT_SIZE} bytes)"

# Verify snapshot integrity — etcd 3.6 moved this to etcdutl
if command -v etcdutl &>/dev/null; then
    etcdutl snapshot status "${SNAPSHOT_PATH}" --write-out=table || \
        log "WARNING: Could not verify snapshot (non-fatal)"
else
    log "INFO: etcdutl not available — skipping snapshot verification (etcd 3.6+)"
fi

# ─── Upload to S3 ────────────────────────────────────────────────────
S3_KEY="${S3_PREFIX}/${TIMESTAMP}.db"
log "Uploading to s3://${S3_BUCKET}/${S3_KEY}..."

aws s3 cp "${SNAPSHOT_PATH}" "s3://${S3_BUCKET}/${S3_KEY}" \
    --sse AES256 \
    --region "${AWS_REGION}" \
    --quiet

# Maintain a "latest" pointer for easy restore (in-bucket copy avoids re-upload)
aws s3 cp "s3://${S3_BUCKET}/${S3_KEY}" "s3://${S3_BUCKET}/${S3_PREFIX}/latest.db" \
    --sse AES256 \
    --region "${AWS_REGION}" \
    --quiet

log "Upload complete: s3://${S3_BUCKET}/${S3_KEY}"

# ─── Prune Old Backups (keep last 168 = 7 days × 24 hourly) ──────────
BACKUP_COUNT=$(aws s3 ls "s3://${S3_BUCKET}/${S3_PREFIX}/" \
    --region "${AWS_REGION}" 2>/dev/null \
    | grep -c "\.db$" || echo "0")

MAX_BACKUPS=168
if [[ "${BACKUP_COUNT}" -gt "${MAX_BACKUPS}" ]]; then
    PRUNE_COUNT=$((BACKUP_COUNT - MAX_BACKUPS))
    log "Pruning ${PRUNE_COUNT} old backups (keeping ${MAX_BACKUPS})..."
    aws s3 ls "s3://${S3_BUCKET}/${S3_PREFIX}/" --region "${AWS_REGION}" \
        | grep "\.db$" \
        | sort \
        | head -n "${PRUNE_COUNT}" \
        | awk '{print $NF}' \
        | while read -r old_file; do
            aws s3 rm "s3://${S3_BUCKET}/${S3_PREFIX}/${old_file}" \
                --region "${AWS_REGION}" --quiet
        done
    log "Pruning complete"
fi

# ─── Cleanup ──────────────────────────────────────────────────────────
rm -f "${SNAPSHOT_PATH}"
log "✓ etcd backup complete — s3://${S3_BUCKET}/${S3_KEY}"
