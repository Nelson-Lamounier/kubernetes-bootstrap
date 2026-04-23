#!/usr/bin/env bash
# @format
# Install etcd Backup Timer — systemd service + timer
#
# Creates a systemd timer that runs etcd-backup.sh hourly.
# Idempotent: safe to run multiple times.
#
# Called by the control plane bootstrap (step_install_etcd_backup).
#
# Files created:
#   /usr/local/bin/etcd-backup.sh           — the backup script
#   /etc/systemd/system/etcd-backup.service — oneshot service unit
#   /etc/systemd/system/etcd-backup.timer   — hourly timer

set -euo pipefail

SCRIPT_NAME="install-etcd-backup-timer"
log() { echo "[${SCRIPT_NAME}] $(date '+%Y-%m-%d %H:%M:%S') $1"; }

# ─── Resolve paths ────────────────────────────────────────────────────
# The DR scripts are synced from S3 to the bootstrap directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKUP_SCRIPT="${SCRIPT_DIR}/etcd-backup.sh"
INSTALL_PATH="/usr/local/bin/etcd-backup.sh"

if [[ ! -f "${BACKUP_SCRIPT}" ]]; then
    log "ERROR: etcd-backup.sh not found at ${BACKUP_SCRIPT}"
    exit 1
fi

# ─── Install backup script ───────────────────────────────────────────
log "Installing etcd-backup.sh to ${INSTALL_PATH}..."
cp -f "${BACKUP_SCRIPT}" "${INSTALL_PATH}"
chmod 755 "${INSTALL_PATH}"

# ─── Create systemd service ──────────────────────────────────────────
log "Creating systemd service unit..."
cat > /etc/systemd/system/etcd-backup.service << 'EOF'
[Unit]
Description=etcd snapshot backup to S3
After=kubelet.service
Requires=kubelet.service
# Only run on nodes with etcd certificates (control plane)
ConditionPathExists=/etc/kubernetes/pki/etcd/ca.crt

[Service]
Type=oneshot
EnvironmentFile=-/etc/profile.d/k8s-env.sh
ExecStart=/usr/local/bin/etcd-backup.sh
# Log output for CloudWatch collection
StandardOutput=journal
StandardError=journal
SyslogIdentifier=etcd-backup
EOF

# ─── Create systemd timer ────────────────────────────────────────────
log "Creating systemd timer (hourly)..."
cat > /etc/systemd/system/etcd-backup.timer << 'EOF'
[Unit]
Description=Hourly etcd backup to S3

[Timer]
# Run every hour, with a random 5-minute offset to avoid thundering herd
OnCalendar=hourly
RandomizedDelaySec=300
# If the system was off when a backup was due, run it on next boot
Persistent=true

[Install]
WantedBy=timers.target
EOF

# ─── Enable and start ────────────────────────────────────────────────
log "Enabling and starting timer..."
systemctl daemon-reload
systemctl enable etcd-backup.timer
systemctl start etcd-backup.timer

# Verify
STATUS=$(systemctl is-active etcd-backup.timer)
if [[ "${STATUS}" == "active" ]]; then
    log "✓ etcd-backup.timer is active"
    systemctl list-timers --no-pager | grep etcd-backup || true
else
    log "WARNING: Timer status is '${STATUS}' — check with: systemctl status etcd-backup.timer"
fi

# Run an initial backup immediately
log "Running initial etcd backup..."
if "${INSTALL_PATH}"; then
    log "✓ Initial etcd backup succeeded"
else
    log "WARNING: Initial etcd backup failed — timer will retry in 1 hour"
fi

log "✓ etcd backup timer installation complete"
