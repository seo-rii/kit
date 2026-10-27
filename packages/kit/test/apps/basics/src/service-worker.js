import { immutable } from '$app/manifest';
import { version } from '$app/env';
import { PUBLIC_STATIC } from '$app/env/public';
import { resolve, self } from '$app/service-worker';

/** @typedef {{ waitUntil(value: Promise<unknown>): void }} ExtendableEventLike */
/** @typedef {{ request: Request; respondWith(value: Response | PromiseLike<Response>): void }} FetchEventLike */

const name = `cache-${version}-${PUBLIC_STATIC}`;

self.addEventListener('install', (/** @type {ExtendableEventLike} */ event) => {
	event.waitUntil(caches.open(name).then((cache) => cache.addAll(immutable.map((x) => x.path))));
});

self.addEventListener('activate', (/** @type {ExtendableEventLike} */ event) => {
	event.waitUntil(
		caches.keys().then(async (keys) => {
			for (const key of keys) {
				if (!key.includes(version)) caches.delete(key);
			}
		})
	);
});

self.addEventListener('fetch', (/** @type {FetchEventLike} */ event) => {
	const { request } = event;

	const url = new URL(request.url);

	if (
		url.pathname.endsWith('/worker-fallback/target/__data.json') ||
		url.pathname.endsWith('/worker-fallback/streaming/__data.json') ||
		request.headers.has('x-test-worker-fallback')
	) {
		event.respondWith(resolve(event, { strategy: 'worker-first' }));
		return;
	}

	if (request.method !== 'GET' || request.headers.has('range')) return;

	const cached = caches.match(request);

	if (url.origin === location.origin && immutable.some((a) => url.pathname.includes(a.path))) {
		// always return build files from cache
		event.respondWith(cached.then((response) => response ?? fetch(request)));
	} else if (url.protocol === 'https:' || location.hostname === 'localhost') {
		// hit the network for everything else...
		const promise = fetch(request);

		// ...and cache successful responses...
		promise.then((response) => {
			// cache successful responses
			if (response.ok && response.type === 'basic') {
				const clone = response.clone();
				caches.open(name).then((cache) => {
					cache.put(request, clone);
				});
			}
		});

		// ...but if it fails, fall back to cache or SvelteKit's route-aware worker resolver
		event.respondWith(promise.catch(() => cached.then((response) => response || resolve(event))));
	}
});
