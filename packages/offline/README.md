# SvelteKit offline extension experiment

This private workspace package tests an external offline policy on top of a small SvelteKit extension. It requires the Kit changes in this branch; published SvelteKit 3.1 does not expose these APIs. The package owns read policy, optional remote response caching, and an explicit mutation outbox. Kit owns route matching and its data response format.

## Read fallbacks

Enable the experimental bridge in `vite.config.js`:

```js
import { defineConfig } from 'vite';
import { sveltekit } from '@sveltejs/kit/vite';

export default defineConfig({
  plugins: [sveltekit({ experimental: { serviceWorkerFallbacks: true } })]
});
```

Register browser-safe replacements for existing server loads. Registration is explicit; `page.offline.js` and `layout.offline.js` are ordinary filenames, not new Kit route conventions.

```js
// src/service-worker/index.js
import { self, resolveData } from '$app/service-worker';
import { createOfflineHandler } from 'sveltekit-offline';
import { load as page } from '../routes/tasks/page.offline.js';
import { load as layout } from '../routes/tasks/layout.offline.js';

const handle = createOfflineHandler({
  resolveData,
  handlers: { '/tasks': { layout, page } },
  strategy: 'network-first'
});

self.addEventListener('fetch', (event) => {
  event.respondWith(handle(event.request));
});
```

Compose this handler with your asset and document caching policy. It does not install an offline document shell or precache assets. Use Kit 3's `$app/manifest` and `$app/env` for those tasks. A previously loaded application can navigate with local data; a first visit or document reload while offline also needs an application shell policy.

```js
// src/routes/tasks/page.offline.js
/** @type {import('$app/service-worker').DataFallbackLoad} */
export async function load({ params, url, parent, network }) {
  const shared = await parent();
  return {
    ...shared,
    filter: url.searchParams.get('filter') ?? 'all',
    tasks: [], // replace with an application-owned IndexedDB read
    connection: network.status
  };
}
```

Use a shared application DTO for server and offline data. This experiment does not change generated route `$types`. Fallback code is shipped to the browser and must not import server modules. Its context has `request`, tracked `url`, typed matcher results in `params`, `route.id`, the source `node`, lazy `parent()`, and a connection hint. `network.status` is a browser hint, not a reachability guarantee. `server({ timeout, signal })` makes an explicit GET attempt and returns the raw `Response`. Its `timeout` limits the wait for response headers; the original request signal and optional caller signal also cancel response body reads.

The default `network-first` strategy falls back only after a rejected network request. HTTP errors and aborts retain their original behavior. `worker-first` tries a local data response before the network. Both strategies pass non-GET requests to the network once. Neither captures bodies or queues writes.

`resolveData` handles same-origin Kit data navigation requests. It returns `null` for unsupported requests, unmatched routes, or missing required server-node replacements, including an unavailable ancestor requested through `parent()`. A route with any participating layout or page whose options cannot be statically analyzed is also excluded, so the worker does not guess runtime trailing-slash behavior. Kit supplies route precedence, groups and layout resets, matchers, rerouting, partial invalidation, transport encoding, and deferred data chunks. Universal hooks imported into the worker must themselves be worker-compatible.

## Remote response cache

Remote caching is an independent opt-in coordinator:

```js
import { classifyRequest } from '$app/service-worker';
import { version } from '$app/env';
import { createRemoteCache } from 'sveltekit-offline/remote';

const remote = createRemoteCache({
  classifyRequest,
  cacheName: `my-app-remotes-${version}`,
  scope: authenticatedAccountScope
});
```

Use one coordinator for a namespace during a worker lifetime. Route classified remote requests and actions through `remote.handle(request)` before any generic cache handler. Other requests can go to the read or asset handler. Never parse `classifyRequest`'s opaque key.

Kit's default remote responses use `private, no-store`, so they remain uncached. A server response must explicitly opt in with a positive `Cache-Control: max-age`. In this Kit version, remote functions cannot call `setHeaders`; an application server hook can apply the policy after `resolve(event)`. Only opt in when the complete response is suitable for the chosen user scope. `no-store`, `no-cache`, expired responses, `Vary: *`, unsuccessful responses, and SSE responses are excluded. Offline reuse respects `Age`, `Date`, and expiry.

Query and live payloads stay opaque. Remote GET network attempts bypass the browser HTTP cache so it cannot serve an older result after the package invalidates Cache Storage. Live streams pass through. Mutations and enhanced actions invalidate the namespace before and after their single network attempt, including failed attempts. In-flight reads cannot repopulate or use the old cache across that mutation. POST batch queries conservatively invalidate too. Single-flight refresh responses are returned unchanged; the package does not emulate remote commands, forms, live subscriptions, or Kit's client query state.

Supply an authenticated identity scope, rotate it when identity changes, and call `invalidate()` when clearing a session. Scope strings are storage partitions, not authorization. Cache Storage failures disable caching for that coordinator without changing the network result.

## Explicit outbox

The outbox runs in a page or worker with IndexedDB and Web Locks. The application explicitly enqueues domain operations; it does not intercept forms or remote functions.

```js
import { createIndexedDBOutboxStore, createOutbox } from 'sveltekit-offline/outbox';

const store = await createIndexedDBOutboxStore({ name: 'my-app-outbox-v1' });
const outbox = createOutbox({
  scope: authenticatedAccountScope,
  store,
  sender: {
    idempotency: 'operation-id',
    async send({ id, payload, signal }) {
      const response = await fetch('/api/operations', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id, payload }),
        signal
      });
      if (!response.ok) throw new Error('No confirmed receipt');
      // { status: 'confirmed', receipt: ... } or { status: 'rejected', reason: ... }
      return response.json();
    }
  }
});

await outbox.enqueue({ id: crypto.randomUUID(), payload: { type: 'add-task', title: 'Review' } });
await outbox.flush();
const entries = await outbox.list();
```

The server must bind operations to authenticated identity, atomically deduplicate by that identity and operation ID, reject a changed payload for an existing ID, and return the original receipt on retries. Declaring `idempotency: 'operation-id'` asserts that application contract; it cannot enforce it.

| State       | Meaning                                                                              |
| ----------- | ------------------------------------------------------------------------------------ |
| `pending`   | The operation is durably stored and has not been attempted.                          |
| `unknown`   | An attempt was durably recorded before sending; its result is not confirmed locally. |
| `confirmed` | An explicit success receipt was durably stored.                                      |
| `rejected`  | An explicit rejection receipt was durably stored.                                    |

Loss of a response, cancellation, or a crashed sender leaves `unknown`, even if the server applied the operation. Later ordinary flushes skip it. Explicit `flush({ retryUnknown: true })` retries the same identity and payload under the server deduplication contract. Show pending and unknown work distinctly from confirmed state in the UI.

Writes wait for the IndexedDB transaction to complete. Web Locks serialize the store and scope across tabs and workers; a custom lock must provide the same guarantee. Missing locks or storage failures are reported rather than silently degrading to an unsafe queue. Keep operations and receipts JSON-compatible. Operations with different IDs are independent; the queue does not promise FIFO or causal ordering. Identity changes, schema migration, retention, background synchronization, and conflict UI remain application responsibilities.

The browser fixture's deduplication map is test-only and in memory. It demonstrates receipt loss and retry behavior, not a production persistence backend.

## Validation

```sh
pnpm -F @sveltejs/kit test:unit
pnpm -F sveltekit-offline test:unit
pnpm -F sveltekit-offline check
```

Production browser scenarios live in `packages/kit/test/apps/basics/test/playwright/offline-*.test.js`. They exercise actual navigation, partial invalidation, streaming, remote requests, IndexedDB persistence, and cross-tab locks with Chromium. Run from that app using `KIT_E2E_BROWSER=chromium KIT_E2E_PROJECT=js pnpm exec playwright test test/playwright/offline-*.test.js --workers=1`. `KIT_E2E_PORT` selects an isolated port; protected environments can supply `KIT_E2E_DEV_BYPASS_WAF` without storing a cookie in source.
