import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const DR_DIR         = resolve(process.cwd(), 'system/dr');
const ETCD_BACKUP    = `${DR_DIR}/etcd-backup.sh`;
const INSTALL_TIMER  = `${DR_DIR}/install-etcd-backup-timer.sh`;

// ── Syntax validation ──────────────────────────────────────────────────────

describe('shell script bash -n syntax check', () => {
    it.each([
        ['etcd-backup.sh',          ETCD_BACKUP],
        ['install-etcd-backup-timer.sh', INSTALL_TIMER],
    ])('%s parses without errors', (_name, scriptPath) => {
        const result = spawnSync('bash', ['-n', scriptPath], { encoding: 'utf-8' });
        expect(result.status, result.stderr).toBe(0);
    });
});

// ── etcd-backup.sh ─────────────────────────────────────────────────────────

describe('etcd-backup.sh', () => {
    const content = readFileSync(ETCD_BACKUP, 'utf-8');

    it('uses bash strict mode (set -euo pipefail)', () => {
        expect(content).toContain('set -euo pipefail');
    });

    it('saves snapshot to /var/lib/etcd/snapshots (host-visible via kubelet mount)', () => {
        expect(content).toContain('/var/lib/etcd/snapshots');
    });

    it('does not use /tmp for the snapshot (invisible from host when inside container)', () => {
        expect(content).not.toContain('SNAPSHOT_DIR="/tmp');
    });

    it('uploads with AES256 server-side encryption', () => {
        expect(content).toContain('--sse AES256');
    });

    it('uses the dr-backups/etcd S3 prefix for correct IAM scoping', () => {
        expect(content).toContain('S3_PREFIX="dr-backups/etcd"');
    });

    it('uses a run_etcdctl() wrapper for binary vs container portability', () => {
        expect(content).toContain('run_etcdctl()');
    });

    it('fails early when S3_BUCKET is unset', () => {
        expect(content).toContain('-z "${S3_BUCKET}"');
    });

    it('validates all three etcd certificate paths before running', () => {
        expect(content).toContain('ETCD_CACERT=');
        expect(content).toContain('ETCD_CERT=');
        expect(content).toContain('ETCD_KEY=');
    });

    it('removes local snapshot file after successful upload', () => {
        expect(content).toContain('rm -f');
    });

    it('maintains a latest.db pointer for fast restore without listing', () => {
        expect(content).toContain('latest.db');
    });

    it('caps stored backups at 168 (7 days × 24 hourly)', () => {
        expect(content).toContain('MAX_BACKUPS=168');
    });

    it('uses ETCDCTL_API=3', () => {
        expect(content).toContain('ETCDCTL_API=3');
    });
});

// ── install-etcd-backup-timer.sh ───────────────────────────────────────────

describe('install-etcd-backup-timer.sh', () => {
    const content = readFileSync(INSTALL_TIMER, 'utf-8');

    it('uses bash strict mode (set -euo pipefail)', () => {
        expect(content).toContain('set -euo pipefail');
    });

    it('creates a systemd .service unit file', () => {
        expect(content).toContain('etcd-backup.service');
    });

    it('creates a systemd .timer unit file', () => {
        expect(content).toContain('etcd-backup.timer');
    });

    it('enables and starts the timer', () => {
        expect(content).toContain('systemctl enable');
    });

    it('runs an immediate initial backup after installation', () => {
        expect(content).toContain('Running initial etcd backup');
    });

    it('uses ConditionPathExists to restrict service to control-plane nodes', () => {
        expect(content).toContain('ConditionPathExists=');
    });

    it('sets Persistent=true so missed backups run on next boot', () => {
        expect(content).toContain('Persistent=true');
    });
});
