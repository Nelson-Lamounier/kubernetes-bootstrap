<!-- @format -->

# Cache Observability: Prometheus counters over CloudWatch EMF

Cache **effectiveness** (per-scope hit / miss / error) is reported as Prometheus
counters on the unified metric `redis_cache_requests_total{cache, result}` and
viewed in Grafana — not as CloudWatch EMF. The read cache already did this
(`RedisReadCache` → public-api `/metrics`); the AI-gen **exact cache**
(`RedisExactCache`) is moved off EMF onto the same counter so Bedrock cache
behaviour is visible per service in the same pane as everything else.

## Context

The exact AI-gen cache (`aigen:*`, used by job-strategist) emitted
`CacheHit/CacheMiss/CacheError` as CloudWatch EMF under `BedrockSharedSafety`,
dimensioned only by `Module:'cache'`. That data is invisible in Grafana, cannot
be attributed to a scope/service (so it can't answer "is *this* service being
served from cache"), and the EMF lines pollute the Loki log stream. Meanwhile
the BFF read cache (`shared:*`) already reports hit/miss as a Prometheus counter
on public-api's `/metrics`. See [redis-read-cache-shared-key-invalidation.md](./redis-read-cache-shared-key-invalidation.md)
for the cache topology.

## Decision

- Unify on `redis_cache_requests_total{cache, result}` in Prometheus for both
  Redis caches; remove the `CacheHit/CacheMiss` EMF from `RedisExactCache`
  (grounding-safety EMF is unaffected).
- Delivery splits by runtime, deliberately: long-running services (public-api)
  expose `/metrics` and are scraped; short-lived Jobs (job-strategist
  clustering/case-study) register the counter on their job registry and push via
  Pushgateway (`instance=pipelineRunId`), as resume-import does.
- Add a `redis_cache_enabled` gauge so the fail-open "cache disabled"
  (`REDIS_CACHE_HOST` unset) state is observable, not a silent log line.

## Consequences

- "Is it caching where it should" becomes a watchable/alertable signal:
  `RedisCacheIneffective` (request volume above a floor with a near-zero hit
  ratio → key-mismatch / TTL / disabled bug) and `RedisCacheDisabled`.
- Redis **server health** (memory, evictions, clients, persistence, up) is a
  separate concern, covered by the `redis_exporter` (annotation-scraped, no
  Operator) — global per instance, not per scope.
