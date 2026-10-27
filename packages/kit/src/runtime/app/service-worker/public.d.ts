/// <reference no-default-lib="true"/>
/// <reference lib="esnext" />
/// <reference lib="webworker" />

/**
 * Options for resolving a service worker fetch event with SvelteKit's route-aware fallback
 * handling.
 */
export interface ResolveOptions {
	/**
	 * The fallback strategy. `network-first` fetches from the server and runs matching
	 * `+layout.worker.js` and `+page.worker.js` loads or actions only if that fetch rejects.
	 * HTTP error responses do not trigger the fallback.
	 *
	 * `worker-first` runs matching worker loads or actions before fetching from the server,
	 * and falls back to the server if the worker modules cannot produce a response.
	 *
	 * @default 'network-first'
	 */
	strategy?: 'network-first' | 'worker-first';
}

/**
 * Resolve a service worker fetch event with SvelteKit's route-aware fallback handling.
 */
export function resolve(
	event: Request | { request: Request },
	options?: ResolveOptions
): Promise<Response>;

/**
 * The execution context of a service worker. This export exists to make it easier to
 * use service workers with the correct types, provided the importing module is governed
 * by a `tsconfig.json` that extends [`$app/tsconfig/service-worker`](https://svelte.dev/docs/kit/$app-tsconfig-service-worker).
 */
export const self: ServiceWorkerGlobalScope;
