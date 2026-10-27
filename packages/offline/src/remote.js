/** @import { RemoteCache, RemoteCacheOptions } from './remote-public.js' */

const stored_at_header = 'x-sveltekit-offline-stored-at';

/**
 * Cache explicitly opted-in remote reads without interpreting SvelteKit's payload format.
 *
 * @param {RemoteCacheOptions} options
 * @returns {RemoteCache}
 */
export function createRemoteCache({
	classifyRequest: classify_request,
	cacheName: cache_name,
	scope,
	fetch = globalThis.fetch,
	storage = globalThis.caches
}) {
	if (typeof cache_name !== 'string' || !cache_name.trim()) {
		throw new TypeError('A versioned cacheName is required');
	}
	if (typeof scope !== 'string' || !scope.trim()) {
		throw new TypeError('An explicit cache scope is required');
	}

	const namespace = `sveltekit-offline:${JSON.stringify([cache_name, scope])}`;
	let generation = 0;
	let active_mutations = 0;
	let storage_available = !!storage;
	let queue = Promise.resolve();
	/** @type {Map<string, { generation: number; active: number }>} */
	const pending_reads = new Map();

	/**
	 * Serialize puts, matches, and invalidations so a late put cannot race a delete.
	 * Storage failures disable this coordinator instead of changing a network result.
	 * @template T
	 * @param {() => Promise<T>} operation
	 * @returns {Promise<T | undefined>}
	 */
	function with_storage(operation) {
		const result = queue.then(async () => {
			if (!storage_available) return;
			try {
				return await operation();
			} catch {
				storage_available = false;
			}
		});
		queue = result.then(() => {});
		return result;
	}

	async function invalidate() {
		generation += 1;
		await with_storage(() => storage.delete(namespace));
	}

	/** @param {Request} request */
	async function handle(request) {
		request.signal.throwIfAborted();
		const { kind, key } = classify_request(request);

		if (kind === 'remote-mutation' || kind === 'action') {
			active_mutations += 1;
			try {
				await invalidate();
				request.signal.throwIfAborted();
				return await fetch(request);
			} finally {
				await invalidate();
				active_mutations -= 1;
			}
		}

		// Live streams and unrelated requests never clone bodies or touch the cache.
		if (kind !== 'remote-query' || request.method !== 'GET' || !key) {
			return fetch(request);
		}

		// HTTP cache entries cannot be invalidated alongside this coordinator's namespace.
		const network_request = new Request(request, { cache: 'no-store' });
		if (active_mutations > 0) return fetch(network_request);

		const request_generation = generation;
		const cache_request = new Request(key, { headers: request.headers });
		const reads = pending_reads.get(key) ?? { generation: 0, active: 0 };
		pending_reads.set(key, reads);
		reads.active += 1;
		const read_generation = reads.generation;
		const is_current_generation = () => generation === request_generation && active_mutations === 0;
		const is_current = () => is_current_generation() && reads.generation === read_generation;
		try {
			let response;
			let received_at;
			let freshness;
			/** @type {ArrayBuffer | null} */
			let body = null;
			try {
				response = await fetch(network_request);
				request.signal.throwIfAborted();
				received_at = Date.now();
				freshness = get_freshness(response, received_at);
				if (!freshness && is_current_generation()) {
					// Fence existing reads before awaiting storage, including pending cache matches.
					// Revocation deletes every Vary variant, so they share the same generation.
					reads.generation += 1;
				}
				if (freshness && storage_available && is_current() && response.body !== null) {
					// Body failures are transport failures, not CacheStorage failures. Finish the
					// download before queuing storage work so it cannot hold up invalidations.
					body = await response.clone().arrayBuffer();
				}
			} catch (error) {
				request.signal.throwIfAborted();
				if (error && typeof error === 'object' && 'name' in error && error.name === 'AbortError') {
					throw error;
				}

				const cached = await with_storage(async () => {
					if (!is_current() || request.signal.aborted) return;
					const cache = await storage.open(namespace);
					const match = await cache.match(cache_request);
					if (!match) return;

					const timestamp = match.headers.get(stored_at_header);
					const stored_at = timestamp === null ? NaN : Number(timestamp);
					const freshness = get_freshness(match, stored_at);
					const now = Date.now();
					if (!freshness || now < stored_at || now >= freshness.expires_at) {
						await cache.delete(cache_request, { ignoreVary: true });
						return;
					}

					const headers = new Headers(match.headers);
					headers.delete(stored_at_header);
					headers.set('age', String(Math.floor((freshness.age + now - stored_at) / 1000)));
					return new Response(match.body, {
						status: match.status,
						statusText: match.statusText,
						headers
					});
				});
				request.signal.throwIfAborted();
				if (cached && is_current()) return cached;
				throw error;
			}

			await with_storage(async () => {
				if (!(freshness ? !request.signal.aborted && is_current() : is_current_generation()))
					return;
				const cache = await storage.open(namespace);
				if (!freshness) {
					// Once received, revocation survives cancellation of the caller's request.
					await cache.delete(cache_request, { ignoreVary: true });
					return;
				}

				const headers = new Headers(response.headers);
				headers.set(stored_at_header, String(received_at));
				await cache.put(
					cache_request,
					new Response(body, { status: response.status, statusText: response.statusText, headers })
				);
			});
			request.signal.throwIfAborted();
			return response;
		} finally {
			reads.active -= 1;
			if (reads.active === 0) pending_reads.delete(key);
		}
	}

	return { handle, invalidate };
}

/**
 * @param {Response} response
 * @param {number} received_at
 * @returns {{ expires_at: number; age: number } | null}
 */
function get_freshness(response, received_at) {
	if (!Number.isFinite(received_at) || !response.ok || response.status === 206) return null;
	if (
		response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() ===
		'text/event-stream'
	) {
		return null;
	}
	if (
		response.headers
			.get('vary')
			?.split(',')
			.some((value) => value.trim() === '*')
	)
		return null;

	const directives = (response.headers.get('cache-control') ?? '').split(',').map((v) => v.trim());
	if (directives.some((value) => /^(no-store|no-cache)(?:\s*=|$)/i.test(value))) return null;
	const max_age_directives = directives.filter((value) => /^max-age(?:\s*=|$)/i.test(value));
	if (max_age_directives.length !== 1) return null;
	const match = /^max-age\s*=\s*(?:"(\d+)"|(\d+))$/i.exec(max_age_directives[0]);
	const max_age = match ? Number(match[1] ?? match[2]) : 0;
	if (!Number.isSafeInteger(max_age) || max_age <= 0) return null;

	const age_header = response.headers.get('age');
	if (age_header !== null && !/^\d+$/.test(age_header)) return null;
	let age = Number(age_header ?? 0) * 1000;
	const date_header = response.headers.get('date');
	if (date_header !== null) {
		const date = Date.parse(date_header);
		if (!Number.isFinite(date)) return null;
		age = Math.max(age, received_at - date);
	}

	const expires_at = received_at + max_age * 1000 - age;
	return Number.isFinite(expires_at) && expires_at > received_at ? { expires_at, age } : null;
}
