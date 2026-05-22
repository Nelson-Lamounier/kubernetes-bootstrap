<!-- @format -->

# Cluster Data Tier

The stateful caching/queueing services on the EKS cluster and the vocabulary
for how applications consume them. Distinguishes the two unrelated "cache"
concepts that have collided in conversation: the Redis **read cache** and the
Postgres **semantic cache**.

## Language

**redis-cache**:
Standalone Redis tuned as a cache (ephemeral, `allkeys-lru`, no persistence).
Its job is an exact-key, hot-path **read cache** for BFF read endpoints — not
AI-generation caching. Lives in namespace `redis-cache`.
_Avoid_: "the cache" (ambiguous — say "read cache" or "semantic cache").

**redis-broker**:
Standalone Redis tuned as a durable job queue / pub-sub (AOF on, `noeviction`,
EBS PVC). Backs the AI-pipeline job workers. Lives in namespace `redis-broker`.
_Avoid_: calling it "cache" — it never evicts and must not lose data.

**Read cache**:
The exact-key get-or-compute layer over **redis-cache** that wraps expensive
BFF reads. Keyed by entity identity (e.g. `{domain}:{entity}:{id}:v{schema}`).
To be built; no application code consumes redis-cache yet.
_Avoid_: "semantic cache" (different mechanism and backing store).

**Semantic cache** (`PgSemanticCache`):
Postgres + pgvector cosine-similarity cache for Bedrock/chatbot AI-generation
responses. Backed by `platform-rds`, **not** Redis. It replaced an earlier
`RedisExactCache` (the AI-gen exact cache), which is why redis-cache no longer
serves the AI-generation path.
_Avoid_: conflating with the Redis read cache.

**Shared cache key**:
A read-cache key for an entity that one app writes and another reads (e.g. a
project written by admin-api, read by public-api). Keyed identically in both
apps — `shared:{domain}:{entity}:{id}:v{schema}` — with **no** per-app prefix,
so the writer's invalidation (a `DEL` on its write path) reaches the reader's
entry. The key scheme is a strict cross-repo contract.
_Avoid_: prefixing a shared key per app (breaks cross-app invalidation).

**App-private cache key**:
A read-cache key only one app reads and writes. Carries that app's
`REDIS_CACHE_KEY_PREFIX` (e.g. `pub:v1:…`). No cross-app coordination needed.

**redis client label**:
A namespace label (`tucaken.com/redis-cache-client` /
`tucaken.com/redis-broker-client`) that gates the Redis chart's NetworkPolicy
ingress. An app namespace without the label is silently denied at the network
layer — the label is load-bearing, not bookkeeping.

## Example dialogue

> **Dev:** I'll point the cache at Redis.
> **Platform:** Which cache? The AI-generation responses go to the **semantic
> cache** — that's Postgres + pgvector, not Redis. Redis-cache is the **read
> cache** for BFF hot reads.
> **Dev:** Right, this is the project-detail read path, so **read cache** —
> redis-cache.
> **Platform:** Then the consuming namespace needs the
> `tucaken.com/redis-cache-client` label or the NetworkPolicy drops it.
