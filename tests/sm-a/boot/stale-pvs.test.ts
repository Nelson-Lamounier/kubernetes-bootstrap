import { describe, expect, it } from 'vitest';

import { findStalePvs } from '../../../sm-a/boot/steps/worker.js';

const pv = (
    name: string,
    ns: string,
    pvcName: string,
    hostname: string,
) => ({
    metadata: { name },
    spec: {
        claimRef: { namespace: ns, name: pvcName },
        nodeAffinity: {
            required: {
                nodeSelectorTerms: [{
                    matchExpressions: [{
                        key: 'kubernetes.io/hostname',
                        values: [hostname],
                    }],
                }],
            },
        },
    },
});

describe('findStalePvs', () => {
    it('detects PV pinned to a dead node', () => {
        const json = JSON.stringify({ items: [pv('pv-grafana', 'monitoring', 'grafana-data', 'dead-node-1')] });
        const stale = findStalePvs(json, new Set(['live-node-1', 'live-node-2']));

        expect(stale).toHaveLength(1);
        expect(stale[0].pvName).toBe('pv-grafana');
        expect(stale[0].pvcName).toBe('grafana-data');
        expect(stale[0].deadNode).toBe('dead-node-1');
    });

    it('ignores PVs pinned to live nodes', () => {
        const json = JSON.stringify({ items: [pv('pv-prometheus', 'monitoring', 'prometheus-data', 'live-node-1')] });
        expect(findStalePvs(json, new Set(['live-node-1']))).toHaveLength(0);
    });

    it('ignores PVs outside the monitoring namespace', () => {
        const json = JSON.stringify({ items: [pv('pv-default', 'default', 'some-data', 'dead-node-1')] });
        expect(findStalePvs(json, new Set(['live-node-1']))).toHaveLength(0);
    });

    it('returns empty list when no PVs exist', () => {
        expect(findStalePvs(JSON.stringify({ items: [] }), new Set(['live-node-1']))).toHaveLength(0);
    });

    it('returns empty list on invalid JSON', () => {
        expect(findStalePvs('not valid json', new Set(['live-node-1']))).toHaveLength(0);
    });

    it('detects multiple stale PVs in one pass', () => {
        const json = JSON.stringify({
            items: [
                pv('pv-a', 'monitoring', 'pvc-a', 'dead-1'),
                pv('pv-b', 'monitoring', 'pvc-b', 'dead-2'),
                pv('pv-c', 'monitoring', 'pvc-c', 'live-1'),
            ],
        });
        const stale = findStalePvs(json, new Set(['live-1']));
        expect(stale).toHaveLength(2);
        expect(stale.map(s => s.pvName).sort()).toEqual(['pv-a', 'pv-b']);
    });
});
