# SvelteKit offline extension experiment

This private workspace package tests an external offline policy on top of a small SvelteKit extension. It requires the Kit changes in this branch; published SvelteKit 3.1 does not expose these APIs. The package owns read policy and optional remote response caching. Kit owns route matching and its data response format.

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

Use a shared application DTO for server and offline data. This experiment does not change generated route `$types`. Fallback code is shipped to the browser and must not import server modules. Its context has `request`, tracked `url`, typed matcher results in `params`, `route.id`, the source `node`, lazy `parent()`, and a connection hint. `network.status` is a browser hint, not a reachability guarantee. `server({ timeout, signal })` makes an explicit GET attempt and returns the raw `Response`.

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

## Validation

```sh
pnpm -F @sveltejs/kit test:unit
pnpm -F sveltekit-offline test:unit
pnpm -F sveltekit-offline check
```

Production browser scenarios live in `packages/kit/test/apps/basics/test/playwright/offline-*.test.js`. They exercise actual navigation, partial invalidation, streaming, remote requests, IndexedDB persistence, and cross-tab locks with Chromium. Run from that app using `KIT_E2E_BROWSER=chromium KIT_E2E_PROJECT=js pnpm exec playwright test test/playwright/offline-*.test.js --workers=1`. `KIT_E2E_PORT` selects an isolated port; protected environments can supply `KIT_E2E_DEV_BYPASS_WAF` without storing a cookie in source.
