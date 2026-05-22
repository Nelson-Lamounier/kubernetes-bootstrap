<!-- @format -->

# Redis Read-Cache: Shared Key Scheme for Cross-App Invalidation

Cross-app cached entities (written by one BFF, read by another) use an
**unprefixed shared key** — `shared:{domain}:{entity}:{id}:v{schema}` — keyed
identically in every app, so the writing app's `DEL` on its mutation path
invalidates the reading app's cached entry. Per-app `REDIS_CACHE_KEY_PREFIX`
applies only to app-private cache entries.

## Context

`redis-cache` is a shared instance: it hosts the BFF hot-key **read cache**
(`shared:*`, this decision) alongside the **AI-gen exact cache** (`aigen:*`,
used by job-strategist), plus there's a separate pgvector **semantic cache** —
see [CONTEXT.md](../../CONTEXT.md). This decision concerns the read cache, whose
first consumer is the **project (case study)** entity:

- **public-api** (`@bedrock/shared`, ai-applications repo) reads project detail
  via `getOrCompute`.
- **admin-api** (`@repo/admin-api`, tucaken-app repo) creates/updates/deletes
  projects.

The two BFFs live in **separate monorepos** and share no code — only this
contract. If each prefixed its keys per-app (`pub:…`, `adm:…`), admin-api's
write path could not name, and therefore could not invalidate, public-api's
cached key. The reader would serve stale content until TTL lapsed.

## Decision

For any entity one app writes and another reads, both apps key it as
`shared:{domain}:{entity}:{id}:v{schema}` with no per-app prefix. The writer
issues `DEL shared:…` on every mutation path. TTL (1h) is a backstop, not the
primary freshness mechanism. `v{schema}` is bumped when the serialized shape
changes, giving a deploy-safe cache flush.

**Key by `id`, not by the reader's lookup keys.** public-api reads a project by
`(username, slug)`, but admin-api operates on `id`. To let both sides agree, the
reader does a cheap **uncached** lookup `(username, slug) → (id, visibility)`,
enforces the visibility gate there, then `getOrCompute(shared:project:case_study:{id}:v1)`
for the expensive ~10-table assembly. admin-api — which has `id` on every write
path — invalidates by exact `DEL`. Keeping the resolve step uncached means a
project flipped to `private` 404s before the assembly cache is consulted, so
there is no stale-public-after-private window.

**The invalidation surface is wide.** The cached value is a denormalised
assembly of the project plus decisions, architecture, highlights, challenges,
stack, depth and tags. Every admin-api endpoint that mutates *any* of those
sub-resources for a project must invalidate the project's key — not just
`PATCH /:id`, but `/:id/confirm`, `/:id/regenerate`, `/:id/decisions/:did`,
`/:id/architecture`, `/:id/split`, `/merge`, and `DELETE /:id`. A single missed
path serves a stale case study.

## Considered alternatives

- **Short TTL, no cross-app invalidation** — simpler, but admin edits lag on
  the public site for the full TTL window. Rejected: content staleness is
  user-visible.
- **Pub/sub invalidation channel** — near-instant, decoupled keys, but adds
  subscriber lifecycle and missed-message handling. Rejected as overkill at
  current scale.

## Known gap — asynchronous regeneration

`POST /:id/regenerate` (and `/:id/confirm`) enqueue a Kubernetes Job that
rewrites the case-study content **later**; admin-api invalidates the key at
*enqueue* time, not at job completion. A public read arriving in that window
re-caches the pre-regeneration content, which then persists until the 1h TTL.
Accepted for now (TTL backstops it; regenerations are infrequent). A complete
fix would have the regeneration Job — or `platform-job-watcher` — call the same
invalidation when the new content lands. Tracked as follow-up, not in the first
slice.

## Consequence (the trap this prevents)

The shared key scheme is **load-bearing**, like the `redis-client` namespace
labels. A future change that "tidies up" by adding a per-app prefix to shared
keys will silently break cross-app invalidation and serve stale reads — with no
error. Treat the `shared:` key format as a strict cross-repo contract.
