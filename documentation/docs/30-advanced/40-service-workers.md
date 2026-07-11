---
title: Service workers
---

Service workers act as proxy servers that handle network requests inside your app. This makes it possible to make your app work offline, but even if you don't need offline support (or can't realistically implement it because of the type of app you're building), it's often worth using service workers to speed up navigation by precaching your built JS and CSS.

In SvelteKit, if you have a `src/service-worker.js` file (or `src/service-worker/index.js`) it will be bundled and automatically registered.

## Inside the service worker

Inside the service worker you have access to the [`$service-worker` module]($service-worker), which provides you with the paths to all static assets, build files and prerendered pages. You're also provided with an app version string, which you can use for creating a unique cache name, and the deployment's `base` path. If your Vite config specifies `define` (used for global variable replacements), this will be applied to service workers as well as your server/client builds.

The following example caches the built app and any files in `static` eagerly, and caches all other requests as they happen. This would make each page work offline once visited.

```js
// @errors: 2688
/// file: src/service-worker.js
// Disables access to DOM typings like `HTMLElement` which are not available
// inside a service worker and instantiates the correct globals
/// <reference no-default-lib="true"/>
/// <reference lib="esnext" />
/// <reference lib="webworker" />

// Ensures that the `$service-worker` import has proper type definitions
/// <reference types="@sveltejs/kit" />

// Only necessary if you have an import from `$env/static/public`
/// <reference types="../.svelte-kit/ambient.d.ts" />

import { build, files, version } from '$service-worker';

// This gives `self` the correct types
const self = /** @type {ServiceWorkerGlobalScope} */ (/** @type {unknown} */ (globalThis.self));

// Create a unique cache name for this deployment
const CACHE = `cache-${version}`;

const ASSETS = [
	...build, // the app itself
	...files  // everything in `static`
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

		// `build`/`files` can always be served from the cache
		if (ASSETS.includes(url.pathname)) {
			const response = await cache.match(url.pathname);

			if (response) {
				return response;
			}
		}

		// for everything else, try the network first, but
		// fall back to the cache if we're offline
		try {
			const response = await fetch(event.request);

			// if we're offline, fetch can return a value that is not a Response
			// instead of throwing - and we can't pass this non-Response to respondWith
			if (!(response instanceof Response)) {
				throw new Error('invalid response from fetch');
			}

			if (response.status === 200 && !response.headers.get('cache-control')?.includes('no-store')) {
				cache.put(event.request, response.clone());
			}

			return response;
		} catch (err) {
			const response = await cache.match(event.request);

			if (response) {
				return response;
			}

			// if there's no cache, then just error out
			// as there is nothing we can do to respond to this request
			throw err;
		}
	}

	event.respondWith(respond());
});
```

> [!NOTE] Be careful when caching! In some cases, stale data might be worse than data that's unavailable while offline. Since browsers will empty caches if they get too full, you should also be careful about caching large assets like video files.

> [!NOTE] `build` and `prerendered` are empty arrays during development

## Fallback route data

> [!NOTE] This API is experimental and may change.

Enable worker fallbacks in your SvelteKit config:

```js
/// file: svelte.config.js
/** @type {import('@sveltejs/kit').Config} */
const config = {
	kit: {
		experimental: {
			serviceWorkerFallbacks: true
		}
	}
};

export default config;
```

If a route uses `+layout.server.js` or `+page.server.js`, client-side navigation needs a SvelteKit data request to reach the server. A service worker can use `resolve` from `$service-worker` together with `+layout.worker.js` and `+page.worker.js` to provide fallback route data when that data request fails, while keeping SSR enabled for normal requests.

This API handles SvelteKit data requests made during client-side navigation and requests from [enhanced form actions](form-actions#Progressive-enhancement). It does not render uncached document navigations, handle `+server.js` endpoints or arbitrary fetch requests, intercept unenhanced form submissions, or provide service-worker hooks. Continue to use `src/service-worker.js` for caching, asset requests and other service-worker behavior.

```js
/// file: src/service-worker.js
/// <reference no-default-lib="true"/>
/// <reference lib="esnext" />
/// <reference lib="webworker" />
/// <reference types="@sveltejs/kit" />

import { build, resolve, version } from '$service-worker';

const self = /** @type {ServiceWorkerGlobalScope} */ (/** @type {unknown} */ (globalThis.self));
const CACHE = `cache-${version}`;

self.addEventListener('install', (event) => {
	event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(build)));
});

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

Add worker modules next to the layouts and pages that need fallback data. Each worker module needs the Web Worker library references shown below for the correct editor environment. SvelteKit excludes these modules from the app's generated TypeScript program so that worker-only globals such as `ServiceWorkerGlobalScope` do not become available in the rest of your app.

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

SvelteKit generates `$worker-types.d.ts` next to the usual route `$types.d.ts`, along with `.svelte-kit/tsconfig.worker.json`, which uses the `WebWorker` library and does not automatically include `@types` packages. This is a separate TypeScript program because DOM and worker globals cannot safely coexist in the app program. It inherits options such as `strict` and `checkJs` from your root `tsconfig.json` or `jsconfig.json`. Run it explicitly in addition to your normal checks:

```sh
npx tsc -p .svelte-kit/tsconfig.worker.json
```

If you use a custom [`outDir`](configuration#outDir), replace `.svelte-kit` with that directory.

`resolve(event)` is network-first by default. It only runs matching worker loads or actions after `fetch(event.request)` fails. You can use `resolve(event, { strategy: 'worker-first' })` if your service worker already knows it should prefer fallback data, for example when `navigator.onLine === false`.

Worker data replaces the matching layout or page server data for that request. If an invalidated server layout or page does not have a corresponding worker module, the resolver leaves the original network failure in place instead of returning partial route data. Promises returned from worker loads are streamed using SvelteKit's data response format, so `{#await data.products}` continues to work during client navigation. `server()` retries the original SvelteKit data or enhanced action request and returns the raw `Response`; it is intended for advanced handling, not for returning `await response.json()` directly from a worker load or action. Worker actions can return an `ActionResult` directly, or return a plain object for a successful action result.

Worker loads cannot replace universal `+layout.js` or `+page.js` loads, and worker actions only run for enhanced SvelteKit action requests.

## Manual registration

You can [disable automatic registration](configuration#serviceWorker) if you need to register the service worker with your own logic. The default registration looks something like this:

```js
import { dev } from '$app/environment';

if ('serviceWorker' in navigator) {
	addEventListener('load', function () {
		navigator.serviceWorker.register('./path/to/service-worker.js', {
			type: dev ? 'module' : 'classic'
		});
	});
}
```

> [!NOTE] The service worker is bundled for production, but not during development.

## Other solutions

SvelteKit's service worker implementation is designed to be easy to work with and is probably a good solution for most users. However, outside of SvelteKit, many PWA applications leverage the [Workbox](https://web.dev/learn/pwa/workbox) library. If you're used to using Workbox you may prefer [Vite PWA plugin](https://vite-pwa-org.netlify.app/frameworks/sveltekit.html).

## References

For more general information on service workers, we recommend [the MDN web docs](https://developer.mozilla.org/en-US/docs/Web/API/Service_Worker_API/Using_Service_Workers).
