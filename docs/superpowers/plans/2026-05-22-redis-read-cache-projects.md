<!-- @format -->

# Redis Read-Cache (Project Case Study) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Redis read cache for the public project case-study endpoint, with cross-app invalidation from admin-api on every project mutation, instrumented for a measurable hit-rate.

**Architecture:** `redis-cache` is the BFF hot-key read cache (the AI-gen semantic cache stays on Postgres+pgvector — see [CONTEXT.md](../../../CONTEXT.md)). public-api wraps the expensive ~10-table case-study assembly in `getOrCompute(shared:project:case_study:{id}:v1)` after a cheap uncached `(username,slug)→id` resolve that keeps the visibility gate correct. admin-api `DEL`s that key on every endpoint that mutates the project or its sub-resources. Keys are an unprefixed cross-repo contract (see [docs/decisions/redis-read-cache-shared-key-invalidation.md](../../decisions/redis-read-cache-shared-key-invalidation.md)). Both apps expose Prometheus metrics; hit-rate = `rate(hits)/rate(hits+miss)` on public-api.

**Tech Stack:** TypeScript, ioredis, Hono, prom-client, jest, Helm, External Secrets Operator (`aws-ssm` ClusterSecretStore), ArgoCD.

**Repos touched:**
- `ai-applications` — `@bedrock/shared` (cache module) + `@repo/public-api` (reader)
- `tucaken-app` — `@repo/admin-api` (writer/invalidator)
- `kubernetes-bootstrap` — Helm charts + ESO

**Cross-repo contract (must be identical everywhere):**
| Env var | Meaning | Default |
|---|---|---|
| `REDIS_CACHE_HOST` | redis-cache service DNS | unset ⇒ cache disabled (fail-open) |
| `REDIS_CACHE_PORT` | port | `6379` |
| `REDIS_CACHE_PASSWORD` | auth (from ESO) | unset ⇒ no auth |
| `REDIS_CACHE_TLS` | `"true"`/`"false"` | `false` (plaintext in-cluster) |
| `REDIS_CACHE_DEFAULT_TTL_SECONDS` | default TTL | `3600` |

**Shared key (cross-app entity):** `shared:project:case_study:{projectId}:v1` — no per-app prefix. Bump `v1`→`v2` when the serialized payload shape changes.

---

## Phase A — `@bedrock/shared`: RedisReadCache

Working dir: `ai-applications/applications/shared`. Test runner: `jest` (`yarn test`). Module system: commonjs with `.js` import extensions. `prom-client` already a dependency.

### Task A1: Add ioredis dependency

**Files:**
- Modify: `ai-applications/applications/shared/package.json`

- [ ] **Step 1: Add the dependency**

Add `"ioredis": "^5.4.1"` to the `dependencies` block (alphabetical, after `"@modelcontextprotocol/sdk"` or wherever it sorts).

- [ ] **Step 2: Install**

Run: `cd ai-applications && yarn install`
Expected: lockfile updates, `ioredis` resolved, no errors.

- [ ] **Step 3: Commit**

```bash
git add ai-applications/applications/shared/package.json ai-applications/yarn.lock
git commit -m "build(shared): add ioredis for redis read cache"
```

### Task A2: Config resolver + types (TDD)

**Files:**
- Create: `ai-applications/applications/shared/src/cache/redis-read-cache.ts`
- Test: `ai-applications/applications/shared/src/cache/redis-read-cache.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
/** @format */
import { resolveRedisCacheConfig } from './redis-read-cache.js';

describe('resolveRedisCacheConfig', () => {
    const ENV = process.env;
    beforeEach(() => { process.env = { ...ENV }; });
    afterEach(() => { process.env = ENV; });

    it('is disabled (fail-open) when REDIS_CACHE_HOST is unset', () => {
        delete process.env.REDIS_CACHE_HOST;
        const cfg = resolveRedisCacheConfig();
        expect(cfg.enabled).toBe(false);
    });

    it('parses host/port/password and defaults', () => {
        process.env.REDIS_CACHE_HOST = 'redis-cache-master.redis-cache.svc.cluster.local';
        process.env.REDIS_CACHE_PASSWORD = 'secret';
        delete process.env.REDIS_CACHE_PORT;
        delete process.env.REDIS_CACHE_TLS;
        delete process.env.REDIS_CACHE_DEFAULT_TTL_SECONDS;
        const cfg = resolveRedisCacheConfig();
        expect(cfg).toMatchObject({
            enabled: true,
            host: 'redis-cache-master.redis-cache.svc.cluster.local',
            port: 6379,
            password: 'secret',
            tls: false,
            defaultTtlSeconds: 3600,
        });
    });

    it('parses REDIS_CACHE_TLS=true as tls:true', () => {
        process.env.REDIS_CACHE_HOST = 'h';
        process.env.REDIS_CACHE_TLS = 'true';
        expect(resolveRedisCacheConfig().tls).toBe(true);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ai-applications/applications/shared && yarn test redis-read-cache`
Expected: FAIL — `Cannot find module './redis-read-cache.js'`.

- [ ] **Step 3: Write minimal implementation**

```typescript
/**
 * @format
 * RedisReadCache — exact-key, fail-open read-through cache over redis-cache.
 *
 * Backs BFF hot-read paths (NOT the AI-generation semantic cache, which is
 * Postgres+pgvector; see CONTEXT.md). Fail-open: a missing host or any Redis
 * error degrades to a cache miss / no-op — the cache must never throw into a
 * host request. Cross-app entities use the unprefixed `shared:` key scheme so
 * the writing app can invalidate the reading app's entry.
 */
import Redis, { type RedisOptions } from 'ioredis';

export interface RedisCacheConfig {
    readonly enabled: boolean;
    readonly host: string;
    readonly port: number;
    readonly password: string | undefined;
    readonly tls: boolean;
    readonly defaultTtlSeconds: number;
}

/** Telemetry sink — apps inject adapters that bump their own counters. */
export interface CacheMetrics {
    onHit?(cache: string): void;
    onMiss?(cache: string): void;
    onError?(cache: string): void;
}

export function resolveRedisCacheConfig(): RedisCacheConfig {
    const host = process.env.REDIS_CACHE_HOST ?? '';
    return {
        enabled: host !== '',
        host,
        port: Number(process.env.REDIS_CACHE_PORT ?? '6379'),
        password: process.env.REDIS_CACHE_PASSWORD || undefined,
        tls: (process.env.REDIS_CACHE_TLS ?? 'false') === 'true',
        defaultTtlSeconds: Number(process.env.REDIS_CACHE_DEFAULT_TTL_SECONDS ?? '3600'),
    };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ai-applications/applications/shared && yarn test redis-read-cache`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add ai-applications/applications/shared/src/cache/redis-read-cache.ts ai-applications/applications/shared/src/cache/redis-read-cache.test.ts
git commit -m "feat(shared): redis read-cache config resolver (fail-open)"
```

### Task A3: `RedisLike` client factory

**Files:**
- Modify: `ai-applications/applications/shared/src/cache/redis-read-cache.ts`

- [ ] **Step 1: Add the client interface + factory**

Append to `redis-read-cache.ts`:

```typescript
/** Subset of ioredis the cache depends on — lets tests inject a fake. */
export interface RedisLike {
    get(key: string): Promise<string | null>;
    set(key: string, value: string, mode: 'EX', ttlSeconds: number): Promise<unknown>;
    del(...keys: string[]): Promise<number>;
    scan(cursor: string | number, matchToken: 'MATCH', pattern: string, countToken: 'COUNT', count: number): Promise<[string, string[]]>;
}

/**
 * Build an ioredis client tuned to fail fast / fail open: no offline queue,
 * a capped retry budget, and a bounded command timeout so a slow or down
 * Redis degrades to a miss instead of stalling the request.
 */
export function createRedisClient(cfg: RedisCacheConfig): RedisLike {
    const opts: RedisOptions = {
        host: cfg.host,
        port: cfg.port,
        password: cfg.password,
        enableOfflineQueue: false,
        maxRetriesPerRequest: 1,
        connectTimeout: 1000,
        commandTimeout: 200,
        lazyConnect: false,
        ...(cfg.tls ? { tls: {} } : {}),
    };
    const client = new Redis(opts);
    // Swallow connection errors — fail-open. Without a listener ioredis throws
    // on the process. The cache methods already guard each command.
    client.on('error', () => { /* logged at call sites via onError */ });
    return client as unknown as RedisLike;
}
```

- [ ] **Step 2: Typecheck**

Run: `cd ai-applications/applications/shared && yarn typecheck`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add ai-applications/applications/shared/src/cache/redis-read-cache.ts
git commit -m "feat(shared): fail-fast ioredis client factory"
```

### Task A4: `RedisReadCache` class (TDD)

**Files:**
- Modify: `ai-applications/applications/shared/src/cache/redis-read-cache.ts`
- Modify: `ai-applications/applications/shared/src/cache/redis-read-cache.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to the test file:

```typescript
import { RedisReadCache, type RedisLike } from './redis-read-cache.js';

function fakeRedis(): RedisLike & { store: Map<string, string> } {
    const store = new Map<string, string>();
    return {
        store,
        async get(k) { return store.get(k) ?? null; },
        async set(k, v) { store.set(k, v); return 'OK'; },
        async del(...keys) { let n = 0; for (const k of keys) if (store.delete(k)) n++; return n; },
        async scan() { return ['0', [...store.keys()]]; },
    };
}

describe('RedisReadCache', () => {
    it('computes and stores on miss, then serves from cache on hit', async () => {
        const r = fakeRedis();
        const hits: string[] = []; const misses: string[] = [];
        const cache = new RedisReadCache(r, 3600, { onHit: (c) => hits.push(c), onMiss: (c) => misses.push(c) });
        let computed = 0;
        const compute = async () => { computed++; return { v: 42 }; };

        const a = await cache.getOrCompute('k1', 60, compute, 'proj');
        const b = await cache.getOrCompute('k1', 60, compute, 'proj');

        expect(a).toEqual({ v: 42 });
        expect(b).toEqual({ v: 42 });
        expect(computed).toBe(1);
        expect(misses).toEqual(['proj']);
        expect(hits).toEqual(['proj']);
    });

    it('invalidate deletes the key', async () => {
        const r = fakeRedis();
        const cache = new RedisReadCache(r, 3600, {});
        await cache.getOrCompute('k1', 60, async () => 1, 'proj');
        expect(r.store.has('k1')).toBe(true);
        const n = await cache.invalidate('k1');
        expect(n).toBe(1);
        expect(r.store.has('k1')).toBe(false);
    });

    it('fail-open: a throwing client degrades to compute, never throws', async () => {
        const broken: RedisLike = {
            get: async () => { throw new Error('down'); },
            set: async () => { throw new Error('down'); },
            del: async () => { throw new Error('down'); },
            scan: async () => { throw new Error('down'); },
        };
        const errors: string[] = [];
        const cache = new RedisReadCache(broken, 3600, { onError: (c) => errors.push(c) });
        const v = await cache.getOrCompute('k1', 60, async () => 'fresh', 'proj');
        expect(v).toBe('fresh');
        await expect(cache.invalidate('k1')).resolves.toBe(0);
        expect(errors.length).toBeGreaterThan(0);
    });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd ai-applications/applications/shared && yarn test redis-read-cache`
Expected: FAIL — `RedisReadCache is not a constructor`.

- [ ] **Step 3: Implement the class**

Append to `redis-read-cache.ts`:

```typescript
export class RedisReadCache {
    constructor(
        private readonly client: RedisLike,
        private readonly defaultTtlSeconds: number,
        private readonly metrics: CacheMetrics = {},
    ) {}

    /**
     * Return the cached JSON value for `key`, or compute it, store it with
     * `ttlSeconds` (defaulting to the configured default), and return it.
     * Fail-open: any Redis error falls through to `compute()`.
     * `cacheName` is the metrics label (low cardinality, e.g. 'project_case_study').
     */
    async getOrCompute<T>(
        key: string,
        ttlSeconds: number,
        compute: () => Promise<T>,
        cacheName: string,
    ): Promise<T> {
        try {
            const cached = await this.client.get(key);
            if (cached !== null) {
                this.metrics.onHit?.(cacheName);
                return JSON.parse(cached) as T;
            }
            this.metrics.onMiss?.(cacheName);
        } catch {
            this.metrics.onError?.(cacheName);
            return compute();
        }
        const fresh = await compute();
        try {
            await this.client.set(key, JSON.stringify(fresh), 'EX', ttlSeconds || this.defaultTtlSeconds);
        } catch {
            this.metrics.onError?.(cacheName);
        }
        return fresh;
    }

    /** Explicit write. Fail-open. */
    async set<T>(key: string, value: T, ttlSeconds?: number): Promise<void> {
        try {
            await this.client.set(key, JSON.stringify(value), 'EX', ttlSeconds ?? this.defaultTtlSeconds);
        } catch { /* fail-open */ }
    }

    /** Delete one key. Returns count deleted (0 on error). */
    async invalidate(key: string): Promise<number> {
        try {
            return await this.client.del(key);
        } catch {
            return 0;
        }
    }

    /** Delete keys matching a glob via non-blocking SCAN. Returns count (0 on error). */
    async invalidatePattern(pattern: string): Promise<number> {
        try {
            let cursor = '0';
            let total = 0;
            do {
                const [next, keys] = await this.client.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
                cursor = next;
                if (keys.length > 0) total += await this.client.del(...keys);
            } while (cursor !== '0');
            return total;
        } catch {
            return 0;
        }
    }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd ai-applications/applications/shared && yarn test redis-read-cache`
Expected: PASS (6 tests total).

- [ ] **Step 5: Commit**

```bash
git add ai-applications/applications/shared/src/cache/redis-read-cache.ts ai-applications/applications/shared/src/cache/redis-read-cache.test.ts
git commit -m "feat(shared): RedisReadCache getOrCompute/invalidate (fail-open, TDD)"
```

### Task A5: Export from the package barrel + key helper

**Files:**
- Modify: `ai-applications/applications/shared/src/cache/index.ts`
- Modify: `ai-applications/applications/shared/src/cache/redis-read-cache.ts`

- [ ] **Step 1: Add the project key helper**

Append to `redis-read-cache.ts`:

```typescript
/**
 * Canonical cross-app key for a project case study. Used identically by the
 * reader (public-api) and the writer (admin-api). See the shared-key ADR.
 */
export function projectCaseStudyKey(projectId: string): string {
    return `shared:project:case_study:${projectId}:v1`;
}
```

- [ ] **Step 2: Re-export from the barrel**

Add to `src/cache/index.ts`:

```typescript
export {
    RedisReadCache,
    resolveRedisCacheConfig,
    createRedisClient,
    projectCaseStudyKey,
} from './redis-read-cache.js';
export type { RedisCacheConfig, RedisLike, CacheMetrics } from './redis-read-cache.js';
```

- [ ] **Step 3: Build to confirm the barrel resolves**

Run: `cd ai-applications/applications/shared && yarn build`
Expected: `dist/` regenerates with `cache/redis-read-cache.js`, no TS errors.

- [ ] **Step 4: Commit**

```bash
git add ai-applications/applications/shared/src/cache/index.ts ai-applications/applications/shared/src/cache/redis-read-cache.ts
git commit -m "feat(shared): export RedisReadCache + projectCaseStudyKey"
```

---

## Phase B — `@repo/public-api`: reader integration + metrics

Working dir: `ai-applications/api/public-api`. Test runner: `jest`. `prom-client` is NOT yet a dependency.

### Task B1: Add prom-client dependency

**Files:**
- Modify: `ai-applications/api/public-api/package.json`

- [ ] **Step 1: Add dependency**

Add `"prom-client": "^15.1.3"` to `dependencies`.

- [ ] **Step 2: Install**

Run: `cd ai-applications && yarn install`
Expected: resolves, no errors.

- [ ] **Step 3: Commit**

```bash
git add ai-applications/api/public-api/package.json ai-applications/yarn.lock
git commit -m "build(public-api): add prom-client for cache metrics"
```

### Task B2: Prometheus registry + cache counter

**Files:**
- Create: `ai-applications/api/public-api/src/lib/metrics.ts`

- [ ] **Step 1: Create the registry + counter**

```typescript
/**
 * @file metrics.ts
 * @description Prometheus registry for public-api. Mirrors admin-api's
 * low-cardinality counter conventions. Scraped at GET /metrics by the
 * cluster Prometheus (kubernetes-service-endpoints job).
 */
import { Registry, Counter, collectDefaultMetrics } from 'prom-client';

export const registry = new Registry();
registry.setDefaultLabels({
  service: process.env['OTEL_SERVICE_NAME'] ?? 'public-api',
  env:     process.env['DEPLOY_ENV']         ?? 'dev',
});

collectDefaultMetrics({ register: registry });

/**
 * Read-cache outcomes. `cache` is the logical cache name (e.g.
 * project_case_study); `result` is hit | miss | error. Hit-rate =
 * rate(result="hit") / rate(result=~"hit|miss").
 */
export const redisCacheRequestsTotal = new Counter({
  name:       'redis_cache_requests_total',
  help:       'Read-cache outcomes by cache name and result.',
  labelNames: ['cache', 'result'] as const,
  registers:  [registry],
});
```

- [ ] **Step 2: Typecheck**

Run: `cd ai-applications/api/public-api && yarn typecheck`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add ai-applications/api/public-api/src/lib/metrics.ts
git commit -m "feat(public-api): prom-client registry + redis_cache_requests_total"
```

### Task B3: `/metrics` route

**Files:**
- Create: `ai-applications/api/public-api/src/routes/metrics.ts`
- Modify: `ai-applications/api/public-api/src/index.ts`

- [ ] **Step 1: Create the route**

```typescript
/**
 * @file metrics.ts
 * @description GET /metrics — Prometheus exposition. NetworkPolicy restricts
 * scraping to the monitoring namespace (chart networkpolicy.yaml).
 */
import { Hono } from 'hono';
import { registry } from '../lib/metrics.js';

const metrics = new Hono();

metrics.get('/metrics', async (c) => {
  const body = await registry.metrics();
  return c.body(body, 200, { 'Content-Type': registry.contentType });
});

export default metrics;
```

- [ ] **Step 2: Mount it in `index.ts`**

Add the import alongside the other route imports:

```typescript
import metrics from './routes/metrics.js';
```

Add the mount in the Routes block (after `app.route('/', health);`):

```typescript
app.route('/', metrics);
```

- [ ] **Step 3: Typecheck**

Run: `cd ai-applications/api/public-api && yarn typecheck`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add ai-applications/api/public-api/src/routes/metrics.ts ai-applications/api/public-api/src/index.ts
git commit -m "feat(public-api): expose GET /metrics"
```

### Task B4: Cache singleton wired to metrics

**Files:**
- Create: `ai-applications/api/public-api/src/lib/cache.ts`

- [ ] **Step 1: Create the singleton**

```typescript
/**
 * @file cache.ts
 * @description Process-wide RedisReadCache singleton for public-api, wired to
 * the prom-client counter. Fail-open: if REDIS_CACHE_HOST is unset the cache
 * is a no-op pass-through (getOrCompute always computes).
 */
import {
  RedisReadCache,
  resolveRedisCacheConfig,
  createRedisClient,
  type CacheMetrics,
} from '@bedrock/shared';
import { redisCacheRequestsTotal } from './metrics.js';

const metrics: CacheMetrics = {
  onHit:   (cache) => redisCacheRequestsTotal.inc({ cache, result: 'hit' }),
  onMiss:  (cache) => redisCacheRequestsTotal.inc({ cache, result: 'miss' }),
  onError: (cache) => redisCacheRequestsTotal.inc({ cache, result: 'error' }),
};

let _cache: RedisReadCache | undefined;

/** Lazy singleton — one ioredis connection per process, reused across requests. */
export function getReadCache(): RedisReadCache {
  if (!_cache) {
    const cfg = resolveRedisCacheConfig();
    if (!cfg.enabled) {
      // Disabled: a client whose every command rejects → fail-open compute path.
      const disabled = {
        get:  async () => { throw new Error('cache disabled'); },
        set:  async () => { throw new Error('cache disabled'); },
        del:  async () => 0,
        scan: async () => ['0', [] as string[]] as [string, string[]],
      };
      _cache = new RedisReadCache(disabled, cfg.defaultTtlSeconds, metrics);
    } else {
      _cache = new RedisReadCache(createRedisClient(cfg), cfg.defaultTtlSeconds, metrics);
    }
  }
  return _cache;
}

export const READ_CACHE_DEFAULT_TTL = resolveRedisCacheConfig().defaultTtlSeconds;
```

- [ ] **Step 2: Typecheck**

Run: `cd ai-applications/api/public-api && yarn typecheck`
Expected: no errors (requires Phase A built/published in the workspace — run `yarn build` in `applications/shared` first if the workspace resolves to `dist`).

- [ ] **Step 3: Commit**

```bash
git add ai-applications/api/public-api/src/lib/cache.ts
git commit -m "feat(public-api): RedisReadCache singleton wired to prom-client"
```

### Task B5: Two-step read in the projects route

**Files:**
- Modify: `ai-applications/api/public-api/src/routes/projects.ts`

The current handler runs one resolve query (`projectResult`, gated on `visibility='public' AND status<>'archived'`) then a `Promise.all` assembly. Refactor so the **resolve stays uncached** (visibility gate must always be live) and the **assembly + payload build is wrapped in `getOrCompute`**, keyed by `project.id`.

- [ ] **Step 1: Import the cache + key helper**

Add near the existing imports:

```typescript
import { projectCaseStudyKey } from '@bedrock/shared';
import { getReadCache, READ_CACHE_DEFAULT_TTL } from '../lib/cache.js';
```

- [ ] **Step 2: Wrap the assembly**

Inside the handler, after `const project = projectResult.rows[0]; if (!project) return c.json({ error: 'Not found' }, 404);`, wrap everything from the `Promise.all([...])` down to the `payload` object construction in a `getOrCompute` call. Replace the existing assembly + `payload` block with:

```typescript
    const payload = await getReadCache().getOrCompute(
        projectCaseStudyKey(project.id),
        READ_CACHE_DEFAULT_TTL,
        async () => {
            const [
                components, repositories, decisions, highlights, challenges,
                stack, depth, architecture, resumeBullets, tags,
            ] = await Promise.all([
                pool.query<ComponentRow>(
                    `SELECT id, name, kind, order_index
                       FROM project_components WHERE project_id = $1 ORDER BY order_index`,
                    [project.id],
                ),
                pool.query<RepoRow>(
                    `SELECT pc.id AS component_id, r.full_name AS repository_full_name, pr.subpath
                       FROM project_repositories pr
                       JOIN project_components pc ON pc.id = pr.project_component_id
                       JOIN repositories r ON r.id = pr.repository_id
                      WHERE pc.project_id = $1 AND r.is_private = FALSE
                      ORDER BY pc.order_index, r.full_name`,
                    [project.id],
                ),
                pool.query<DecisionRow>(
                    `SELECT title, context, decision, consequences, confidence, source_signals, order_index
                       FROM project_decisions WHERE project_id = $1 ORDER BY order_index`,
                    [project.id],
                ),
                pool.query<HighlightRow>(
                    `SELECT title, description, order_index
                       FROM project_highlights WHERE project_id = $1 ORDER BY order_index`,
                    [project.id],
                ),
                pool.query<ChallengeRow>(
                    `SELECT problem, solution, source_signals, order_index
                       FROM project_challenges WHERE project_id = $1 ORDER BY order_index`,
                    [project.id],
                ),
                pool.query<StackRow>(
                    `SELECT category, name, justification, order_index
                       FROM project_stack_items WHERE project_id = $1 ORDER BY order_index`,
                    [project.id],
                ),
                pool.query<DepthRow>(
                    `SELECT has_tests, test_coverage_signal, has_ci, ci_maturity,
                            documentation_density, has_deployment_evidence, deployment_url, refactor_count
                       FROM project_depth_markers WHERE project_id = $1`,
                    [project.id],
                ),
                pool.query<ArchitectureRow>(
                    `SELECT diagram_format, diagram_source, nodes, edges
                       FROM project_architecture WHERE project_id = $1`,
                    [project.id],
                ),
                pool.query<ResumeBulletRow>(
                    `SELECT angle, bullets
                       FROM project_resume_bullets WHERE project_id = $1`,
                    [project.id],
                ),
                pool.query<TagRow>(
                    `SELECT tag FROM project_tags WHERE project_id = $1 ORDER BY tag`,
                    [project.id],
                ),
            ]);

            return {
                username,
                slug:           project.slug,
                name:           project.name,
                tagline:        project.tagline,
                pitch:          project.pitch,
                type:           project.type,
                shape:          project.shape,
                status:         project.status,
                roleExhibited:  project.role_exhibited,
                startedAt:      project.started_at?.toISOString()       ?? null,
                endedAt:        project.ended_at?.toISOString()         ?? null,
                lastActivityAt: project.last_activity_at?.toISOString() ?? null,
                updatedAt:      project.updated_at.toISOString(),
                components:     components.rows,
                repositories:   repositories.rows,
                decisions:      decisions.rows,
                highlights:     highlights.rows,
                challenges:     challenges.rows,
                stack:          stack.rows,
                depthMarkers:   depth.rows[0] ?? null,
                architecture:   architecture.rows[0] ?? null,
                resumeBullets:  resumeBullets.rows,
                tags:           tags.rows.map((r) => r.tag),
            };
        },
        'project_case_study',
    );

    c.header('Cache-Control', CACHE_CONTROL);
    return c.json(payload);
```

> Note: the resolve query (`projectResult`) and the 404 gate remain **before** and outside `getOrCompute`, so a project flipped to `private`/`archived` 404s without ever consulting the cache.

- [ ] **Step 3: Typecheck**

Run: `cd ai-applications/api/public-api && yarn typecheck`
Expected: no errors.

- [ ] **Step 4: Build the workspace**

Run: `cd ai-applications && yarn workspaces foreach -A run build` (or build `applications/shared` then `api/public-api`).
Expected: both build clean.

- [ ] **Step 5: Commit**

```bash
git add ai-applications/api/public-api/src/routes/projects.ts
git commit -m "feat(public-api): cache project case-study assembly by id (two-step read)"
```

---

## Phase C — `@repo/admin-api`: invalidation + guard + metrics

Working dir: `tucaken-app/admin-api`. Test runner: `jest` (unit) / `vitest` (integration). Module system: ESM (`type: module`), `.js` import extensions. `prom-client` already a dependency.

### Task C1: Add ioredis + invalidation counter

**Files:**
- Modify: `tucaken-app/admin-api/package.json`
- Modify: `tucaken-app/admin-api/src/lib/observability/metrics.ts`

- [ ] **Step 1: Add ioredis**

Add `"ioredis": "^5.4.1"` to `dependencies`.

- [ ] **Step 2: Install**

Run: `cd tucaken-app && yarn install`
Expected: resolves, no errors.

- [ ] **Step 3: Add the counter**

Append to `src/lib/observability/metrics.ts`:

```typescript
// ── Read-cache invalidation (cross-app) ───────────────────────────────────────
// admin-api is the writer for shared cache entities; it DELs the public-api
// read-cache key on every project mutation. result: ok | error.
export const redisCacheInvalidationsTotal = new Counter({
  name:       'redis_cache_invalidations_total',
  help:       'Cross-app read-cache invalidations issued by admin-api.',
  labelNames: ['cache', 'result'] as const,
  registers:  [registry],
});
```

- [ ] **Step 4: Typecheck + commit**

Run: `cd tucaken-app/admin-api && yarn typecheck`
Expected: no errors.

```bash
git add tucaken-app/admin-api/package.json tucaken-app/yarn.lock tucaken-app/admin-api/src/lib/observability/metrics.ts
git commit -m "build(admin-api): add ioredis + redis_cache_invalidations_total"
```

### Task C2: `invalidateProject` helper (TDD)

**Files:**
- Create: `tucaken-app/admin-api/src/lib/redis-cache.ts`
- Test: `tucaken-app/admin-api/src/lib/redis-cache.test.ts`

> The key string MUST match `@bedrock/shared`'s `projectCaseStudyKey` exactly. admin-api cannot import `@bedrock/shared`, so the format is duplicated here and locked by the test in Task C5.

- [ ] **Step 1: Write the failing test**

```typescript
/** @format */
import { __test } from './redis-cache.js';

describe('projectCaseStudyKey (admin-api copy)', () => {
  it('matches the cross-repo contract format', () => {
    expect(__test.projectCaseStudyKey('abc-123')).toBe('shared:project:case_study:abc-123:v1');
  });
});

describe('invalidateProject', () => {
  it('DELs the project key and counts ok', async () => {
    const deleted: string[] = [];
    const client = { del: async (k: string) => { deleted.push(k); return 1; } };
    const counts: Array<{ cache: string; result: string }> = [];
    await __test.invalidateProjectWith(client as never, 'abc-123', (l) => counts.push(l));
    expect(deleted).toEqual(['shared:project:case_study:abc-123:v1']);
    expect(counts).toEqual([{ cache: 'project_case_study', result: 'ok' }]);
  });

  it('fail-open: a throwing client never throws, counts error', async () => {
    const client = { del: async () => { throw new Error('down'); } };
    const counts: Array<{ cache: string; result: string }> = [];
    await expect(
      __test.invalidateProjectWith(client as never, 'abc-123', (l) => counts.push(l)),
    ).resolves.toBeUndefined();
    expect(counts).toEqual([{ cache: 'project_case_study', result: 'error' }]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd tucaken-app/admin-api && yarn test redis-cache`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```typescript
/**
 * @format
 * admin-api read-cache invalidation. admin-api is the WRITER for cross-app
 * cached entities — it only DELs keys (no read-through here). Fail-open: a
 * down/slow Redis must never break a write. The key format is a strict
 * cross-repo contract with @bedrock/shared's projectCaseStudyKey (locked by
 * test). See docs/decisions/redis-read-cache-shared-key-invalidation.md.
 */
import Redis, { type RedisOptions } from 'ioredis';

import { redisCacheInvalidationsTotal } from './observability/metrics.js';

const CACHE_NAME = 'project_case_study';

interface DelClient { del(...keys: string[]): Promise<number>; }

function projectCaseStudyKey(projectId: string): string {
  return `shared:project:case_study:${projectId}:v1`;
}

let _client: DelClient | undefined;
let _enabled: boolean | undefined;

function client(): DelClient | undefined {
  if (_enabled === undefined) {
    const host = process.env['REDIS_CACHE_HOST'] ?? '';
    _enabled = host !== '';
    if (_enabled) {
      const opts: RedisOptions = {
        host,
        port: Number(process.env['REDIS_CACHE_PORT'] ?? '6379'),
        password: process.env['REDIS_CACHE_PASSWORD'] || undefined,
        enableOfflineQueue: false,
        maxRetriesPerRequest: 1,
        connectTimeout: 1000,
        commandTimeout: 200,
        ...((process.env['REDIS_CACHE_TLS'] ?? 'false') === 'true' ? { tls: {} } : {}),
      };
      const c = new Redis(opts);
      c.on('error', () => { /* fail-open */ });
      _client = c as unknown as DelClient;
    }
  }
  return _enabled ? _client : undefined;
}

async function invalidateProjectWith(
  c: DelClient | undefined,
  projectId: string,
  count: (l: { cache: string; result: 'ok' | 'error' }) => void,
): Promise<void> {
  if (!c) return; // disabled — no-op
  try {
    await c.del(projectCaseStudyKey(projectId));
    count({ cache: CACHE_NAME, result: 'ok' });
  } catch {
    count({ cache: CACHE_NAME, result: 'error' });
  }
}

/** Invalidate one project's public read-cache entry. Fail-open. */
export async function invalidateProject(projectId: string): Promise<void> {
  await invalidateProjectWith(client(), projectId, (l) =>
    redisCacheInvalidationsTotal.inc(l),
  );
}

export const __test = { projectCaseStudyKey, invalidateProjectWith };
```

- [ ] **Step 4: Run to verify pass**

Run: `cd tucaken-app/admin-api && yarn test redis-cache`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add tucaken-app/admin-api/src/lib/redis-cache.ts tucaken-app/admin-api/src/lib/redis-cache.test.ts
git commit -m "feat(admin-api): invalidateProject helper (fail-open, TDD)"
```

### Task C3: Wire invalidation into every project-mutating handler

**Files:**
- Modify: `tucaken-app/admin-api/src/routes/projects.ts`

For each handler below, after the DB mutation succeeds (inside the `withUser` result, before `ctx.json(...)`), call `await invalidateProject(<id>)`. Use the project id source listed.

| Handler | id source | Notes |
|---|---|---|
| `PATCH /:id` (patchProject) | `ctx.req.param('id')` | |
| `DELETE /:id` (archiveProject) | `ctx.req.param('id')` | archived ⇒ public 404s anyway, but DEL clears any cached entry |
| `POST /:id/confirm` (confirmProject) | `ctx.req.param('id')` | |
| `POST /:id/regenerate` | `ctx.req.param('id')` | regeneration rewrites sub-resources |
| `PATCH /:id/decisions/:did` (patchDecision) | `ctx.req.param('id')` | |
| `DELETE /:id/decisions/:did` (deleteDecision) | `ctx.req.param('id')` | |
| `PATCH /:id/architecture` (patchArchitecture) | `ctx.req.param('id')` | |
| `POST /:id/split` (splitProject) | `ctx.req.param('id')` **and** the new project id returned by `splitProject` | invalidate both source and new |
| `POST /merge` (mergeProjects) | every id in the merge set (source ids + target id) | invalidate all affected |
| `POST /` (createProject) | — | **no invalidation** — a brand-new project has no cached entry |

- [ ] **Step 1: Import the helper**

Add to the imports in `projects.ts`:

```typescript
import { invalidateProject } from '../lib/redis-cache.js';
```

- [ ] **Step 2: Worked example — `PATCH /:id`**

In the `PATCH /:id` handler, after the `patchProject` call resolves successfully and before returning, add:

```typescript
        await invalidateProject(id);
```

(where `id` is the value already read via `ctx.req.param('id')` in that handler).

- [ ] **Step 3: Apply to the remaining single-id handlers**

Add the same `await invalidateProject(<id>);` line after the successful mutation in: `DELETE /:id`, `POST /:id/confirm`, `POST /:id/regenerate`, `PATCH /:id/decisions/:did`, `DELETE /:id/decisions/:did`, `PATCH /:id/architecture`.

- [ ] **Step 4: Multi-id handlers**

For `POST /:id/split`: capture the new id from the `splitProject` return, then:

```typescript
        await invalidateProject(id);
        await invalidateProject(newProject.id); // field name per splitProject's return shape
```

For `POST /merge`: after `mergeProjects` succeeds, invalidate each affected id:

```typescript
        await Promise.all(affectedProjectIds.map((pid) => invalidateProject(pid)));
```

(`affectedProjectIds` = the source ids plus the surviving target id, taken from the merge request body / `mergeProjects` return.)

- [ ] **Step 5: Typecheck**

Run: `cd tucaken-app/admin-api && yarn typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add tucaken-app/admin-api/src/routes/projects.ts
git commit -m "feat(admin-api): invalidate public read-cache on all project mutations"
```

### Task C4: Guard test — every mutating route invalidates

**Files:**
- Create: `tucaken-app/admin-api/src/routes/projects-invalidation.test.ts`

This is the "lint guard": a test that fails if a project-mutating route is added without calling `invalidateProject`. It mounts the real router with a mocked repository + mocked `invalidateProject`, fires each mutating route, and asserts the spy was called.

- [ ] **Step 1: Write the guard test**

```typescript
/** @format */
import { jest } from '@jest/globals';

const invalidateProject = jest.fn(async () => {});
jest.unstable_mockModule('../lib/redis-cache.js', () => ({ invalidateProject }));

// Mock the repository layer so handlers run without a DB. Each fn returns the
// minimal successful shape its handler needs.
jest.unstable_mockModule('../lib/repositories/projects.js', () => ({
  listProjects:     async () => ({ total: 0, rows: [] }),
  getProjectDetail: async () => ({ id: 'p1' }),
  createProject:    async () => ({ id: 'new' }),
  patchProject:     async () => ({ id: 'p1' }),
  archiveProject:   async () => ({ updated: 1 }),
  confirmProject:   async () => ({ updated: 1 }),
  patchDecision:    async () => ({ updated: 1 }),
  deleteDecision:   async () => ({ deleted: 1 }),
  patchArchitecture:async () => ({ updated: 1 }),
  mergeProjects:    async () => ({ targetId: 'p1', mergedIds: ['p2'] }),
  splitProject:     async () => ({ id: 'split-new' }),
}));

// Mock pg withUser to invoke fn with a fake db; getPool returns a stub.
jest.unstable_mockModule('../lib/pg.js', () => ({
  getPool:  () => ({}),
  withUser: async (_pool: unknown, _uid: string, fn: (db: unknown) => Promise<unknown>) => fn({}),
}));

// Stub auth context helper so requireUserId returns a uid.
jest.unstable_mockModule('../lib/types.js', () => ({
  requireUserId: () => 'user-1',
  AdminApiBindings: {},
}));

const { createProjectsRouter } = await import('./projects.js');

const router = createProjectsRouter({} as never);

/** Mutating routes that MUST invalidate. method, path, expected invalidate calls. */
const MUTATING: Array<[string, string, number]> = [
  ['PATCH',  '/p1',                 1],
  ['DELETE', '/p1',                 1],
  ['POST',   '/p1/confirm',         1],
  ['POST',   '/p1/regenerate',      1],
  ['PATCH',  '/p1/decisions/d1',    1],
  ['DELETE', '/p1/decisions/d1',    1],
  ['PATCH',  '/p1/architecture',    1],
  ['POST',   '/p1/split',           2],
  ['POST',   '/merge',              2],
];

describe('project mutation routes invalidate the read cache', () => {
  for (const [method, path, expectedCalls] of MUTATING) {
    it(`${method} ${path} calls invalidateProject`, async () => {
      invalidateProject.mockClear();
      const res = await router.request(path, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: method === 'GET' ? undefined : JSON.stringify({ ids: ['p1', 'p2'], targetId: 'p1' }),
      });
      expect(res.status).toBeLessThan(500);
      expect(invalidateProject).toHaveBeenCalledTimes(expectedCalls);
    });
  }

  it('POST / (create) does NOT invalidate', async () => {
    invalidateProject.mockClear();
    await router.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug: 'new-proj', name: 'New' }),
    });
    expect(invalidateProject).not.toHaveBeenCalled();
  });
});
```

> If a handler's success shape or body validation differs, adjust the mocked repo return / request body so the handler reaches its success path — the assertion (invalidate called N times) is the contract under test. Field names in the `mergeProjects`/`splitProject` mocks must match the real return shapes used in Task C3.

- [ ] **Step 2: Run the guard**

Run: `cd tucaken-app/admin-api && yarn test projects-invalidation`
Expected: PASS once all Task C3 wiring is in place; FAIL (with the offending route) if any mutating route is missing its `invalidateProject` call.

- [ ] **Step 3: Commit**

```bash
git add tucaken-app/admin-api/src/routes/projects-invalidation.test.ts
git commit -m "test(admin-api): guard — every project mutation invalidates read cache"
```

### Task C5: Lock the cross-repo key contract

**Files:**
- Modify: `ai-applications/applications/shared/src/cache/redis-read-cache.test.ts`

A test in BOTH repos asserts the exact key string, so a change in one repo that isn't mirrored fails CI. admin-api's copy is already locked (Task C2). Add the matching assertion in shared.

- [ ] **Step 1: Add the contract assertion**

Append to the shared test file:

```typescript
import { projectCaseStudyKey } from './redis-read-cache.js';

describe('projectCaseStudyKey (cross-repo contract)', () => {
  it('is shared:project:case_study:{id}:v1', () => {
    expect(projectCaseStudyKey('abc-123')).toBe('shared:project:case_study:abc-123:v1');
  });
});
```

- [ ] **Step 2: Run + commit**

Run: `cd ai-applications/applications/shared && yarn test redis-read-cache`
Expected: PASS.

```bash
git add ai-applications/applications/shared/src/cache/redis-read-cache.test.ts
git commit -m "test(shared): lock projectCaseStudyKey contract string"
```

---

## Phase D — `kubernetes-bootstrap`: ESO + chart wiring

Working dir: `kubernetes-bootstrap`. Both app namespaces are already labeled redis-cache clients (public-api chart namespace; admin-api `managedNamespaceMetadata`). The SSM param `/k8s/development/redis-cache-auth` already exists (redis-cache is running on it).

### Task D1: public-api — ExternalSecret + env

**Files:**
- Create: `kubernetes-bootstrap/charts/public-api/external-secrets/public-api-redis-cache.yaml`
- Modify: `kubernetes-bootstrap/charts/public-api/chart/values.yaml`
- Modify: `kubernetes-bootstrap/charts/public-api/chart/templates/deployment.yaml`

- [ ] **Step 1: Create the ExternalSecret**

```yaml
# @format
# ExternalSecret: public-api-redis-cache
#
# Syncs the redis-cache password into the public-api namespace so the BFF can
# authenticate to redis-cache-master.redis-cache.svc. Same SSM SecureString
# that charts/redis-cache reads — single source of truth. Produces Secret
# `public-api-redis-cache` with key REDIS_CACHE_PASSWORD, consumed via
# envFrom (optional). HOST/PORT/TLS are static literals on the Deployment.
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: public-api-redis-cache
  namespace: public-api
  annotations:
    kubernetes.io/description: "redis-cache password for public-api — 1h refresh"
spec:
  refreshInterval: 1h
  secretStoreRef:
    name: aws-ssm
    kind: ClusterSecretStore
  target:
    name: public-api-redis-cache
    creationPolicy: Owner
    deletionPolicy: Delete
    template:
      engineVersion: v2
      type: Opaque
      data:
        REDIS_CACHE_PASSWORD: "{{ .password }}"
  data:
    - secretKey: password
      remoteRef:
        key: /k8s/development/redis-cache-auth
```

- [ ] **Step 2: Add values**

Append to `charts/public-api/chart/values.yaml`:

```yaml
# ---------------------------------------------------------------------------
# Redis read cache (BFF hot-key cache; see kubernetes-bootstrap/CONTEXT.md)
# HOST/PORT/TLS are stable cluster coordinates → static env literals.
# REDIS_CACHE_PASSWORD is synced by external-secrets/public-api-redis-cache.yaml
# and consumed via envFrom (optional). Host unset ⇒ cache disabled (fail-open).
# ---------------------------------------------------------------------------
redisCache:
  host: redis-cache-master.redis-cache.svc.cluster.local
  port: 6379
  tls: false
  defaultTtlSeconds: 3600
```

- [ ] **Step 3: Inject env + envFrom + reloader**

In `charts/public-api/chart/templates/deployment.yaml`:

In the `env:` block, after `ALLOWED_ORIGINS`, add:

```yaml
            - name: REDIS_CACHE_HOST
              value: {{ .Values.redisCache.host | quote }}
            - name: REDIS_CACHE_PORT
              value: {{ .Values.redisCache.port | quote }}
            - name: REDIS_CACHE_TLS
              value: {{ .Values.redisCache.tls | quote }}
            - name: REDIS_CACHE_DEFAULT_TTL_SECONDS
              value: {{ .Values.redisCache.defaultTtlSeconds | quote }}
```

In the `envFrom:` block, add (optional — pod boots before first sync):

```yaml
            - secretRef:
                name: public-api-redis-cache
                optional: true
```

Update the Reloader annotation to include the new secret:

```yaml
        secret.reloader.stakater.com/reload: "public-api-core,public-api-bedrock,public-api-strategist,public-api-redis-cache"
```

- [ ] **Step 4: Lint**

Run: `cd kubernetes-bootstrap && helm lint charts/public-api/chart`
Expected: `1 chart(s) linted, 0 chart(s) failed`.

- [ ] **Step 5: Commit**

```bash
git add kubernetes-bootstrap/charts/public-api/
git commit -m "feat(public-api): wire redis-cache password + REDIS_CACHE_* env"
```

### Task D2: admin-api — ExternalSecret + env

**Files:**
- Create: `kubernetes-bootstrap/charts/admin-api/external-secrets/admin-api-redis-cache.yaml`
- Modify: `kubernetes-bootstrap/charts/admin-api/chart/values.yaml`
- Modify: `kubernetes-bootstrap/charts/admin-api/chart/templates/rollout.yaml`

- [ ] **Step 1: Create the ExternalSecret**

```yaml
# @format
# ExternalSecret: admin-api-redis-cache
#
# Syncs the redis-cache password into the admin-api namespace so the writer
# can DEL public-api's read-cache keys. Same SSM SecureString charts/redis-cache
# reads. Produces Secret `admin-api-redis-cache` with key REDIS_CACHE_PASSWORD.
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: admin-api-redis-cache
  namespace: admin-api
  annotations:
    kubernetes.io/description: "redis-cache password for admin-api invalidation — 1h refresh"
spec:
  refreshInterval: 1h
  secretStoreRef:
    name: aws-ssm
    kind: ClusterSecretStore
  target:
    name: admin-api-redis-cache
    creationPolicy: Owner
    deletionPolicy: Delete
    template:
      engineVersion: v2
      type: Opaque
      data:
        REDIS_CACHE_PASSWORD: "{{ .password }}"
  data:
    - secretKey: password
      remoteRef:
        key: /k8s/development/redis-cache-auth
```

- [ ] **Step 2: Add values**

Append the same `redisCache:` block as Task D1 Step 2 to `charts/admin-api/chart/values.yaml`.

- [ ] **Step 3: Inject env + envFrom + reloader**

In `charts/admin-api/chart/templates/rollout.yaml`:

In the container `env:` block, after `AWS_DEFAULT_REGION`, add the same four `REDIS_CACHE_*` literal entries from Task D1 Step 3.

In the `envFrom:` block, add:

```yaml
            - secretRef:
                name: admin-api-redis-cache
                optional: true
```

Update the Reloader annotation to append `,admin-api-redis-cache`:

```yaml
        secret.reloader.stakater.com/reload: "admin-api-secrets,admin-api-bedrock,admin-api-job-images,admin-api-github,platform-rds-credentials,admin-api-redis-cache"
```

- [ ] **Step 4: Lint**

Run: `cd kubernetes-bootstrap && helm lint charts/admin-api/chart`
Expected: `0 chart(s) failed`.

- [ ] **Step 5: Commit**

```bash
git add kubernetes-bootstrap/charts/admin-api/
git commit -m "feat(admin-api): wire redis-cache password + REDIS_CACHE_* env"
```

### Task D3: public-api Service — Prometheus scrape annotations

**Files:**
- Modify: `kubernetes-bootstrap/charts/public-api/chart/templates/deployment.yaml`

The new `/metrics` endpoint (Phase B) must be discoverable. public-api's NetworkPolicy already allows the monitoring namespace; add scrape annotations to the Service (admin-api's Service has the same).

- [ ] **Step 1: Annotate the Service**

In the `Service` metadata in `deployment.yaml`, add:

```yaml
  annotations:
    prometheus.io/scrape: "true"
    prometheus.io/port:   {{ .Values.port | quote }}
    prometheus.io/path:   "/metrics"
```

- [ ] **Step 2: Lint + commit**

Run: `cd kubernetes-bootstrap && helm lint charts/public-api/chart`
Expected: `0 chart(s) failed`.

```bash
git add kubernetes-bootstrap/charts/public-api/chart/templates/deployment.yaml
git commit -m "feat(public-api): annotate Service for Prometheus scraping"
```

---

## Phase E — Verification (post-merge, live cluster)

> Run after ArgoCD syncs all three repos. These are manual verification steps, not committed code.

- [ ] **Secrets synced:** `kubectl -n public-api get secret public-api-redis-cache` and `kubectl -n admin-api get secret admin-api-redis-cache` both exist with key `REDIS_CACHE_PASSWORD`.
- [ ] **Env present:** `kubectl -n public-api exec deploy/public-api -- printenv | grep REDIS_CACHE_` shows HOST/PORT/TLS/TTL + PASSWORD.
- [ ] **Cache populates:** hit `GET /public/projects/:username/:slug` twice; `kubectl -n redis-cache exec redis-cache-master-0 -c redis -- redis-cli -a "$PW" KEYS 'shared:project:case_study:*'` shows the key.
- [ ] **Hit metric moves:** `curl public-api/metrics | grep redis_cache_requests_total` shows `result="hit"` incrementing on the second request.
- [ ] **Invalidation works:** PATCH the project via admin-api; confirm the key is gone (`redis-cli ... EXISTS <key>` → 0) and `redis_cache_invalidations_total{result="ok"}` incremented on admin-api `/metrics`.
- [ ] **Fail-open:** scale redis-cache to 0 (`kubectl -n redis-cache scale sts redis-cache-master --replicas=0`); confirm `GET /public/projects/...` still returns 200 (served from Postgres) and `redis_cache_requests_total{result="error"}` increments. Scale back to 1.

---

## Self-Review Notes

- **Spec coverage:** Phases A–D cover the resolved design: read-cache abstraction (A), reader + metrics (B), writer + invalidation + guard (C), ESO/chart wiring (D). Phase 7 (observability beyond hit-rate), Phase 8 (broker DR), and Phase 10 (multi-week ops) are out of this slice by design.
- **Cross-repo key contract** is locked by a string-equality test in BOTH repos (A5/C2/C5).
- **Fail-open** is unit-tested in both the reader (A4) and writer (C2) paths.
- **Invalidation completeness** is enforced by the guard test (C4), closing the ADR's "one missed path = stale" trap.
- **Open execution detail:** the exact return-shape field names of `mergeProjects` / `splitProject` (Task C3 Step 4, C4 mocks) must be confirmed against `tucaken-app/admin-api/src/lib/repositories/projects.ts` when implementing — adjust the `affectedProjectIds` / `newProject.id` extraction accordingly.
