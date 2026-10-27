/** @import { OfflineHandlerOptions } from './public.js' */

/**
 * Apply an offline read policy to SvelteKit's experimental data resolver.
 *
 * A rejected network request can fall back to local data. HTTP error responses
 * and mutations are returned unchanged, since neither proves that a request was
 * not processed by the server.
 *
 * @param {OfflineHandlerOptions} options
 * @returns {(request: Request) => Promise<Response>}
 */
export function createOfflineHandler({
	resolveData: resolve_data,
	handlers,
	fetch = globalThis.fetch,
	strategy = 'network-first'
}) {
	if (strategy !== 'network-first' && strategy !== 'worker-first') {
		throw new TypeError(`Unknown offline strategy: ${strategy}`);
	}

	return async (request) => {
		request.signal.throwIfAborted();

		// Do not read or clone mutation bodies, or risk replaying an accepted write.
		if (request.method !== 'GET') return fetch(request);

		if (strategy === 'worker-first') {
			const response = await resolve_data(request, handlers);
			request.signal.throwIfAborted();
			return response ?? fetch(request);
		}

		try {
			return await fetch(request);
		} catch (error) {
			request.signal.throwIfAborted();
			if (error && typeof error === 'object' && 'name' in error && error.name === 'AbortError') {
				throw error;
			}

			const response = await resolve_data(request, handlers);
			request.signal.throwIfAborted();
			if (response) return response;

			// A request outside the resolver's scope keeps its original failure.
			throw error;
		}
	};
}
