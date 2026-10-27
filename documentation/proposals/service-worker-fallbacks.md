# Service worker extension proposal for Kit 3

The existing `sw-v3` PoC integrates worker loads and writes directly into Kit. This alternative starts from upstream `d955d1b604a051c0b21f59c6f9709b36756090b5` (Kit 3.1.0) and keeps offline policy in an external package. The goal is a small core extension that can support competing offline implementations without exposing Kit's private wire protocol.

## Proposed boundary

| Concern | Owner |
| --- | --- |
| Route ordering, layout ancestry, matchers, rerouting, invalidation slots | Kit |
| Transport encoders, deferred chunks, data/error/redirect envelopes | Kit shared serializer |
| Request classification for data, remotes, live streams, and actions | Kit |
| Network-first or worker-first read policy | External package |
| Local database queries and shared application DTOs | Application |
| Response cache scope, freshness, invalidation coordination | External package and application |
| Explicit operation queue, durable states, cross-context locking | External package |
| Authentication, idempotency, effects and receipt transactions | Application server |

The experimental flag is `experimental.serviceWorkerFallbacks`. `$app/service-worker` adds `resolveData(request, handlers)` and `classifyRequest(request)`. The generated worker graph contains route metadata and safe universal imports; it does not import server route code. Without the flag, using the new APIs throws an explicit opt-in error, while existing `self` usage remains available.

The external `sveltekit-offline` package has no Kit runtime-internal imports. It accepts the bridge functions as dependencies. Its entry points separate read policy, remote caching, and an outbox. It is private in this workspace until the core contract is accepted and versioned.

## Migration from the original PoC

1. Keep the complete `sw-v3` implementation as a comparison branch. Carry behavioral cases into production browser tests on current main: SSR, local data navigation, layout parents, partial invalidation, streaming, typed matchers, and rerouting.
2. Replace special `+page.worker` and `+layout.worker` files with ordinary browser-safe modules and explicit route-ID registrations. Share application DTOs between server and local loads. Core generates the hierarchy and serializes responses; the package does not inspect private node indexes or reproduce `__data.json` encoding.
3. Keep reads and writes separate. Remote functions retain their actual server protocol and default cache policy. Applications explicitly enqueue idempotent domain operations and display pending/unknown/confirmed/rejected states. Automatic action replay and local success synthesis are omitted from this proposal.

A Vite integration can later generate the ordinary module registry without another core route-file convention. The current explicit registry is enough to validate the extension boundary and keeps the first proposal independent of discovery and generated-type design.

## Compatibility with Kit 3

Asset and app-shell handling continues to use `$app/manifest` and `$app/env`; the extension does not replace those APIs. Remote query responses are cacheable only after an explicit server opt-in. Live SSE streams pass through. Mutation responses, including single-flight query refreshes, stay intact. Their cache namespace is invalidated before and after transmission so an older in-flight GET cannot restore pre-mutation data.

Fallbacks replace server data loads, not server execution. They do not receive cookies, locals, server hooks, or server-only modules. Universal hooks must be safe to run in a worker. Offline initial documents and reloads require an application shell policy. Runtime-only routing options cannot be reconstructed by evaluating server modules in the worker; unsupported routes must remain on the network path.

An outbox operation is recorded as unknown before sending. Server commitment and receipt delivery are separate events; after a lost reply only the server's idempotency contract makes an explicit retry safe. The implementation therefore makes no exactly-once delivery claim and never interprets a transport error as proof that a write failed.

## Upstream submission shape

The first upstream proposal should contain the guarded bridge, shared serializer extraction, types, and compatibility tests. The policy package and application fixtures demonstrate a consumer but can live in an independent repository. Subsequent proposals should justify registry discovery or route-specific fallback type inference with actual consumer requirements.

Before stabilizing the API, maintainers need to settle the names and granularity of the two exports, how shared DTOs relate to generated route types, and whether the generated graph is an acceptable worker bundle cost. A public serializer alone is insufficient: it would leave plugins coupled to private layout slots and invalidation rules. A generic response cache alone also cannot produce fresh local database reads.

See [the package README](../../packages/offline/README.md) for the implemented contract and executable fixture locations.
