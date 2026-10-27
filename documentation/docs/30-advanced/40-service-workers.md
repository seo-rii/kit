---
title: Service workers
---

Service workers act as proxy servers that handle network requests inside your app. This makes it possible to make your app work offline, but even if you don't need offline support (or can't realistically implement it because of the type of app you're building), it's often worth using service workers to speed up navigation by precaching your built JS and CSS.

In SvelteKit, if you have a `src/service-worker/index.ts` file it will be bundled and automatically registered.

> [!NOTE] `src/service-worker.ts` or `.js` is also valid, but see the section on [type safety](#Type-safety) below

## Inside the service worker

For the service worker to do anything useful, you will likely need to import some stuff:

- [`$app/service-worker`]($app-service-worker) exports `self` which is just `globalThis` typed as [`ServiceWorkerGlobalScope`](https://developer.mozilla.org/en-US/docs/Web/API/ServiceWorkerGlobalScope) (provided you follow [these steps](#Type-safety)), so that your `fetch` events are typed correctly. It also exports the experimental [`resolve`](#Fallback-route-data) function for route-aware fallbacks
- [`$app/env`]($app-env) exports `version`, which is useful for creating deployment-scoped caches
- [`$app/manifest`]($app-manifest) exports `immutable` build files, your `assets`, and any `prerendered` content, allowing you to populate your caches

A typical service worker might look like this:

```js
/// file: src/service-worker.js
/// <reference no-default-lib="true"/>
/// <reference lib="esnext" />
/// <reference lib="webworker" />
// ---cut---
import { self } from '$app/service-worker';
import { version } from '$app/env';
import { immutable, assets } from '$app/manifest';
import { resolve } from '$app/paths';

// Create a unique cache name for this deployment
const CACHE = `cache-${version}`;

// `immutable`/`assets` paths from `$app/manifest` are relative to the
// base path, so resolve them to absolute pathnames that can be matched
// against `url.pathname` in the `fetch` handler
const ASSETS = [
	...immutable.map((asset) => resolve(asset.path)), // the Vite output
	...assets.map((asset) => resolve(asset.path))  // everything in `static`
];

self.addEventListener('install', (event) => {
	// Create a new cache and add all files to it
	async function addFilesToCache() {
		const cache = await caches.open(CACHE);
		await cache.addAll(ASSETS);
	}

	event.waitUntil(addFilesToCache());
});

self.addEventListener('activate', (event) => {
	// Remove previous cached data from disk
	async function deleteOldCaches() {
		for (const key of await caches.keys()) {
			if (key !== CACHE) await caches.delete(key);
		}
	}

	event.waitUntil(deleteOldCaches());
});

self.addEventListener('fetch', (event) => {
	// ignore POST requests etc
	if (event.request.method !== 'GET') return;

	async function respond() {
		const url = new URL(event.request.url);
		const cache = await caches.open(CACHE);

		// `immutable`/`assets` can always be served from the cache
		if (ASSETS.includes(url.pathname)) {
			const response = await cache.match(url.pathname);

			if (response) {
				return response;
			}
		}

		// for everything else, try the network first...
		try {
			const response = await fetch(event.request);

			if (response.status === 200 && !response.headers.get('cache-control')?.includes('no-store')) {
				// ...and cache responses in the background for next time....
				void cache.put(event.request, response.clone());
			}

			return response;
		} catch (error) {
			// ...otherwise fall back to previously cached data if it exists...
			const response = await cache.match(event.request);

			if (response) {
				return response;
			}

			// ...or throw the error
			throw error;
		}
	}

	event.respondWith(respond());
});
```

> [!NOTE] Be careful when caching! In some cases, stale data might be worse than data that's unavailable while offline. Since browsers will empty caches if they get too full, you should also be careful about caching large assets like video files.

## Fallback route data

> [!NOTE] This API is experimental and may change.

Enable worker fallbacks in your SvelteKit Vite plugin configuration:

```js
/// file: vite.config.js
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [
		sveltekit({
			experimental: {
				serviceWorkerFallbacks: true
			}
		})
	]
});
```

If a route uses `+layout.server.js` or `+page.server.js`, client-side navigation needs a SvelteKit data request to reach the server. A service worker can use `resolve` from `$app/service-worker` together with [`+layout.worker.js`](routing#layout-layout.worker.js) and [`+page.worker.js`](routing#page-page.worker.js) to provide fallback route data when that data request fails, while keeping SSR enabled for normal requests.

This API handles SvelteKit data requests made during client-side navigation and requests from [enhanced form actions](form-actions#Progressive-enhancement). It does not render uncached document navigations, handle `+server.js` endpoints or arbitrary fetch requests, or intercept unenhanced form submissions. Continue to use `src/service-worker.js` for caching, asset requests and other service-worker behavior.

```js
/// file: src/service-worker/index.js
import { resolve, self } from '$app/service-worker';

self.addEventListener('fetch', (event) => {
	if (event.request.method === 'POST' && event.request.headers.get('x-sveltekit-action') === 'true') {
		event.respondWith(resolve(event));
		return;
	}

	if (event.request.method !== 'GET') return;

	event.respondWith(
		fetch(event.request).catch(async () => {
			const cached = await caches.match(event.request);
			return cached ?? resolve(event, { strategy: 'worker-first' });
		})
	);
});
```

### Worker modules

Add worker modules next to the layouts and pages that need fallback data. They are bundled into the service worker and delivered to the browser, so they must not contain secrets or import server-only modules. Modules that are not available inside a service worker, such as `$app/forms`, `$app/navigation` and `$app/state`, cannot be imported by worker modules or anything they depend on.

```js
/// file: src/routes/products/+layout.worker.js
/// <reference no-default-lib="true"/>
/// <reference lib="esnext" />
/// <reference lib="webworker" />

/** @type {import('./$worker-types').LayoutWorkerLoad} */
export async function load({ network }) {
	return {
		categories: network.status === 'offline' ? [] : ['featured']
	};
}
```

```js
/// file: src/routes/products/+page.worker.js
/// <reference no-default-lib="true"/>
/// <reference lib="esnext" />
/// <reference lib="webworker" />

/** @type {import('./$worker-types').PageWorkerLoad} */
export async function load({ network, parent, route }) {
	const { categories } = await parent();

	return {
		route: route.id,
		stale: true,
		categories,
		products: Promise.resolve([])
	};
}
```

Worker page modules can also provide fallback responses for enhanced form actions:

```js
/// file: src/routes/products/+page.worker.js
/// <reference no-default-lib="true"/>
/// <reference lib="esnext" />
/// <reference lib="webworker" />

/** @type {import('./$worker-types').PageWorkerActions} */
export const actions = {
	async checkout({ network, request }) {
		const form = await request.formData();

		if (network.status === 'offline') {
			return {
				type: 'failure',
				status: 503,
				data: {
					offline: true,
					sku: form.get('sku')
				}
			};
		}

		return {
			queued: true,
			sku: form.get('sku')
		};
	}
};
```

### Type checking

SvelteKit generates `$worker-types.d.ts` next to the usual route `$types.d.ts`, along with `.svelte-kit/tsconfig.worker.json`. The worker config extends `$app/tsconfig/service-worker`, uses the `WebWorker` library and does not automatically include `@types` packages. It is a separate TypeScript program because DOM and worker globals cannot safely coexist in the app program. Run it explicitly in addition to your normal checks:

```sh
npx tsc -p .svelte-kit/tsconfig.worker.json
```

The generated `$app/tsconfig` excludes route worker modules from the application TypeScript program. If your root `tsconfig.json` overrides `exclude`, also exclude `src/routes/**/+page.worker.*` and `src/routes/**/+layout.worker.*`.

If you use a custom [`outDir`](configuration#outDir), replace `.svelte-kit` with that directory.

### Resolution strategies

`resolve(event)` is network-first by default. It only runs matching worker loads or actions when `fetch(event.request)` rejects, such as during a network or CORS failure. The fetch promise still resolves for an HTTP error response such as `404` or `503`, so that response is returned without running the worker fallback.

You can use `resolve(event, { strategy: 'worker-first' })` if your service worker already knows it should prefer fallback data. Worker-first resolution runs matching worker loads or actions before attempting the server, and fetches from the server if the worker modules cannot produce a response for the request.

### Worker events

Worker loads receive the usual navigation properties such as `params`, `route` and `url`, along with the following properties:

- `request` — the original SvelteKit data request
- `network` — a best-effort connectivity hint whose `status` is `'online'`, `'offline'` or `'unknown'`; it is based on `navigator.onLine` and does not guarantee that the server is reachable
- `parent()` — returns fallback data from parent worker layouts that ran for the current request
- `server({ timeout, signal })` — retries the original SvelteKit data request and returns the raw `Response`; `timeout` is measured in milliseconds and `signal` is an `AbortSignal`

Worker action events additionally provide `action`, containing the selected action name. Their `request` contains the submitted form data, and their `server` method retries the original enhanced action request.

The `server` response uses SvelteKit's internal data or action response format. It is intended for custom retry and response handling — do not return `await response.json()` directly as worker load or action data.

### Actions, hooks and serialization

Worker action names follow the same rules as server actions: a `default` action cannot be mixed with named actions. If a requested action is not present in the worker module, the resolver does not fabricate a worker result — worker-first resolution continues to the server, while network-first resolution preserves the original network failure. Actions can return a plain object for success, an `ActionFailure` created with [`fail`](@sveltejs-kit#fail), or an [`ActionResult`](@sveltejs-kit#ActionResult). Failure and error results use their actual HTTP status, and an action that returns no data produces an empty `204` response.

The resolver applies the universal [`reroute`](hooks#Universal-hooks-reroute) hook before matching a worker route and uses the universal [`transport`](hooks#Universal-hooks-transport) encoders for worker data, streamed promises and action data. There is no dedicated service-worker `handle`, `handleFetch` or `handleError` hook. Because `src/hooks.js` is included in the service-worker bundle when these universal hooks are used, its imports must also be safe to run in a service worker.

Worker data replaces the matching layout or page server data for that request. If an invalidated server layout or page does not have a corresponding worker module, the resolver leaves the original network failure in place instead of returning partial route data. Promises returned from worker loads are streamed using SvelteKit's data response format, so `{#await data.products}` continues to work during client navigation.

Worker loads cannot replace universal `+layout.js` or `+page.js` loads, and worker actions only run for enhanced SvelteKit action requests.

## Type safety

Service workers run in a different context to the rest of your app. As such, they needs different types. You should ensure that your project's root `tsconfig.json` excludes your service worker code...

```json
/// file: tsconfig.json
{
	"extends": "$app/tsconfig",
	"include": ["src", "test"],
	"exclude": ["src/service-worker"]
}
```

...and that your `src/service-worker/index.ts` file sits alongside a separate `tsconfig.json`, which should set up the correct types by extending [`$app/tsconfig/service-worker`]($app-tsconfig-service-worker):

```json
/// file: src/service-worker/tsconfig.json
{
	"extends": "$app/tsconfig/service-worker"
}
```

## Manual registration

You can [disable automatic registration](configuration#serviceWorker) if you need to register the service worker with your own logic. The default registration, which is injected into server-rendered HTML, looks something like this:

```js
if ('serviceWorker' in navigator) {
	const script_url = './service-worker.js';
	const policy = globalThis?.window?.trustedTypes?.createPolicy(
		'sveltekit-trusted-url',
		{ createScriptURL(url) { return url; } }
	);
	const sanitised = policy?.createScriptURL(script_url) ?? script_url;
	addEventListener('load', function () {
		navigator.serviceWorker.register(sanitised, { type: 'module' });
	});
}
```

> [!NOTE] The service worker is bundled for production, but not during development.

## Updating the service worker

Browsers check for an updated service worker when a full-page navigation happens within its scope, and after functional events such as `push` and `sync`. Client-side navigations are neither, so navigating around your app will not by itself cause a new deployment's service worker to be picked up.

SvelteKit calls [`registration.update()`](https://developer.mozilla.org/en-US/docs/Web/API/ServiceWorkerRegistration/update) only as part of error recovery — if a route module fails to load or a navigation results in an error status, and [version polling](configuration#version) detects that the app has been redeployed, the service worker is updated before SvelteKit falls back to a full-page navigation.

If you want new deployments to be picked up more eagerly, you can trigger an update check yourself — for example on every client-side navigation, in your root layout:

```js
import { afterNavigate } from '$app/navigation';

afterNavigate(async () => {
	if ('serviceWorker' in navigator) {
		const registration = await navigator.serviceWorker.getRegistration();
		await registration?.update();
	}
});
```

This will not cause the new service worker (if there is one) to take over the existing page immediately — instead, it will be installed in the background and take over as soon as the number of tabs managed by the existing service worker drops to zero.

## Other solutions

SvelteKit's service worker implementation is designed to be easy to work with and is probably a good solution for most users. However, outside of SvelteKit, many PWA applications leverage the [Workbox](https://web.dev/learn/pwa/workbox) library. If you're used to using Workbox you may prefer [Vite PWA plugin](https://vite-pwa-org.netlify.app/frameworks/sveltekit.html).

## References

For more general information on service workers, we recommend [the MDN web docs](https://developer.mozilla.org/en-US/docs/Web/API/Service_Worker_API/Using_Service_Workers).
