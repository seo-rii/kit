import { afterEach, describe, expect, test, vi } from 'vitest';
import { createRemoteCache } from './remote.js';
/** @import { RemoteCacheOptions, RemoteRequestClassification } from './remote-public.js' */

const query_url = 'https://example.com/app/remote/items?payload=one';
const offline_error = new TypeError('Failed to fetch');

/** @param {Request} request @returns {RemoteRequestClassification} */
function classify_request(request) {
	const url = new URL(request.url);
	if (url.origin !== 'https://example.com') return { kind: 'other', key: null };
	if (url.pathname.startsWith('/app/remote/')) {
		return {
			kind:
				request.method !== 'GET'
					? 'remote-mutation'
					: request.headers.get('accept')?.includes('text/event-stream')
						? 'remote-live'
						: 'remote-query',
			key: url.href
		};
	}
	return {
		kind: request.headers.get('x-sveltekit-action') === 'true' ? 'action' : 'other',
		key: null
	};
}

function memory_storage() {
	/** @type {Map<string, Map<string, { request: Request; response: Response }>>} */
	const namespaces = new Map();
	/** @type {string[]} */
	const operations = [];
	const storage = {
		open: vi.fn((name) => {
			/** @type {Map<string, { request: Request; response: Response }>} */
			const entries = namespaces.get(name) ?? new Map();
			namespaces.set(name, entries);
			return Promise.resolve({
				match: vi.fn(
					/** @returns {Promise<Response | undefined>} */ (request) => {
						operations.push('match');
						const entry = entries.get(request.url);
						if (!entry) return Promise.resolve(undefined);
						const vary = entry.response.headers.get('vary') ?? '';
						if (
							vary.split(',').some((header) => {
								const key = header.trim();
								return key && entry.request.headers.get(key) !== request.headers.get(key);
							})
						) {
							return Promise.resolve(undefined);
						}
						return Promise.resolve(entry.response.clone());
					}
				),
				put: vi.fn(async (request, response) => {
					operations.push('put');
					const body = response.body === null ? null : await response.arrayBuffer();
					entries.set(request.url, {
						request,
						response: new Response(body, {
							status: response.status,
							statusText: response.statusText,
							headers: response.headers
						})
					});
				}),
				delete: vi.fn((request) => {
					operations.push('delete');
					return Promise.resolve(entries.delete(request.url));
				})
			});
		}),
		delete: vi.fn((name) => {
			operations.push('invalidate');
			return Promise.resolve(namespaces.delete(name));
		})
	};
	return { storage, namespaces, operations };
}

/**
 * @param {NonNullable<RemoteCacheOptions['fetch']>} fetch
 * @param {ReturnType<typeof memory_storage>['storage']} storage
 * @param {{ cacheName?: string; scope?: string }} [options]
 */
function create(fetch, storage, options = {}) {
	return createRemoteCache({
		classifyRequest: classify_request,
		cacheName: 'test-version-1',
		scope: 'account-one',
		fetch,
		storage: /** @type {Pick<CacheStorage, 'open' | 'delete'>} */ (
			/** @type {unknown} */ (storage)
		),
		...options
	});
}

/** @param {string} [body] @param {Record<string, string>} [headers] */
function cacheable(body = 'opaque remote data', headers = {}) {
	return new Response(body, {
		headers: {
			'content-type': 'application/json',
			'cache-control': 'private, max-age=60',
			...headers
		}
	});
}

function deferred() {
	return Promise.withResolvers();
}

function streamed_response() {
	const reading = deferred();
	const body = deferred();
	const response = new Response(
		new ReadableStream(
			{
				async pull(controller) {
					reading.resolve(undefined);
					try {
						controller.enqueue(new TextEncoder().encode(await body.promise));
						controller.close();
					} catch (error) {
						controller.error(error);
					}
				}
			},
			{ highWaterMark: 0 }
		),
		{ headers: { 'content-type': 'application/json', 'cache-control': 'private, max-age=60' } }
	);
	return { response, reading: reading.promise, finish: body.resolve, fail: body.reject };
}

afterEach(() => vi.useRealTimers());

test('returns the network response untouched and falls back to opaque cached bytes', async () => {
	const { storage } = memory_storage();
	const response = cacheable('{"data":"not decoded by the cache"}', { 'x-custom': 'preserved' });
	const fetch = vi.fn().mockResolvedValueOnce(response).mockRejectedValue(offline_error);
	const { handle } = create(fetch, storage);
	const request = new Request(query_url);

	expect(await handle(request)).toBe(response);
	expect(response.bodyUsed).toBe(false);
	expect(response.headers.has('x-sveltekit-offline-stored-at')).toBe(false);
	const fallback = await handle(request);
	expect(fallback.status).toBe(200);
	expect(fallback.headers.get('content-type')).toBe('application/json');
	expect(fallback.headers.get('x-custom')).toBe('preserved');
	expect(fallback.headers.has('x-sveltekit-offline-stored-at')).toBe(false);
	expect(await fallback.text()).toBe('{"data":"not decoded by the cache"}');
	expect(fetch).toHaveBeenCalledTimes(2);
});

describe('response body transport failures', () => {
	test('falls back to a fresh same-key value without disabling other cached reads', async () => {
		const { storage } = memory_storage();
		const stream = streamed_response();
		const body_error = new TypeError('Connection reset while receiving the body');
		const fetch = vi
			.fn()
			.mockResolvedValueOnce(cacheable('same-key value'))
			.mockResolvedValueOnce(cacheable('other value'))
			.mockResolvedValueOnce(stream.response)
			.mockRejectedValue(offline_error);
		const { handle } = create(fetch, storage);
		const request = new Request(query_url);
		const other_request = new Request(`${query_url}-other`);
		await handle(request);
		await handle(other_request);
		const failed_read = handle(request);
		await stream.reading;
		stream.fail(body_error);

		expect(await (await failed_read).text()).toBe('same-key value');
		expect(await (await handle(other_request)).text()).toBe('other value');
		expect(await (await handle(request)).text()).toBe('same-key value');
	});

	test('preserves an uncached body error without disabling existing cached reads', async () => {
		const { storage } = memory_storage();
		const stream = streamed_response();
		const body_error = new TypeError('Connection reset while receiving the body');
		const fetch = vi
			.fn()
			.mockResolvedValueOnce(cacheable('other value'))
			.mockResolvedValueOnce(stream.response)
			.mockRejectedValue(offline_error);
		const { handle } = create(fetch, storage);
		const other_request = new Request(`${query_url}-other`);
		await handle(other_request);
		const failed_read = handle(new Request(query_url));
		const rejected = expect(failed_read).rejects.toBe(body_error);
		await stream.reading;
		stream.fail(body_error);
		await rejected;

		expect(await (await handle(other_request)).text()).toBe('other value');
	});

	test('does not hold mutation invalidation behind a pending network body', async () => {
		const { storage } = memory_storage();
		const stream = streamed_response();
		const body_error = new TypeError('Connection reset after the mutation');
		const fetch = vi
			.fn()
			.mockResolvedValueOnce(cacheable('pre-mutation value'))
			.mockResolvedValueOnce(stream.response)
			.mockResolvedValueOnce(new Response('accepted'))
			.mockRejectedValue(offline_error);
		const { handle } = create(fetch, storage);
		await handle(new Request(query_url));
		const pending_read = handle(new Request(query_url));
		const rejected = expect(pending_read).rejects.toBe(body_error);
		await stream.reading;
		const mutation = handle(new Request(query_url, { method: 'POST' }));
		try {
			await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
		} finally {
			stream.fail(body_error);
			await mutation;
			await rejected;
		}

		await expect(handle(new Request(query_url))).rejects.toBe(offline_error);
	});

	test('preserves cancellation during a body read without poisoning other cache entries', async () => {
		const { storage } = memory_storage();
		const stream = streamed_response();
		const controller = new AbortController();
		const reason = new DOMException('Navigation cancelled', 'AbortError');
		const fetch = vi
			.fn()
			.mockResolvedValueOnce(cacheable('other value'))
			.mockResolvedValueOnce(stream.response)
			.mockRejectedValue(offline_error);
		const { handle } = create(fetch, storage);
		const other_request = new Request(`${query_url}-other`);
		await handle(other_request);
		const pending_read = handle(new Request(query_url, { signal: controller.signal }));
		const rejected = expect(pending_read).rejects.toBe(reason);
		await stream.reading;
		controller.abort(reason);
		stream.fail(reason);
		await rejected;

		expect(await (await handle(other_request)).text()).toBe('other value');
	});

	test('a genuine Cache.put failure still disables the coordinator', async () => {
		const { storage } = memory_storage();
		const response = cacheable('online value');
		const fetch = vi
			.fn()
			.mockResolvedValueOnce(cacheable('previous value'))
			.mockResolvedValueOnce(response)
			.mockRejectedValue(offline_error);
		const { handle } = create(fetch, storage);
		await handle(new Request(query_url));
		const open = storage.open.getMockImplementation();
		if (!open) throw new Error('Expected the memory cache implementation');
		storage.open.mockImplementation(async (name) => {
			const cache = await open(name);
			cache.put.mockRejectedValue(new DOMException('Storage is full', 'QuotaExceededError'));
			return cache;
		});

		expect(await handle(new Request(query_url))).toBe(response);
		expect(await response.text()).toBe('online value');
		await expect(handle(new Request(query_url))).rejects.toBe(offline_error);
		expect(storage.open).toHaveBeenCalledTimes(2);
	});
});

test('bypasses the browser HTTP cache while preserving query headers and abort linkage', async () => {
	const { storage } = memory_storage();
	const fetch = vi.fn().mockResolvedValue(cacheable());
	const { handle } = create(fetch, storage);
	const controller = new AbortController();
	const request = new Request(query_url, {
		headers: { 'x-query-header': 'preserved' },
		signal: controller.signal
	});
	await handle(request);
	const received = fetch.mock.calls[0][0];
	expect(received).not.toBe(request);
	expect(received.url).toBe(request.url);
	expect(received.cache).toBe('no-store');
	expect(request.cache).toBe('default');
	expect(received.headers.get('x-query-header')).toBe('preserved');
	controller.abort();
	expect(received.signal.aborted).toBe(true);
});

describe('explicit cache opt-in', () => {
	test.each(
		/** @type {Record<string, string>[]} */ ([
			{},
			{ 'cache-control': 'no-store' },
			{ 'cache-control': 'max-age=60, no-store' },
			{ 'cache-control': 'max-age=60, no-cache' },
			{ 'cache-control': 'max-age=60, no-cache="authorization"' },
			{ 'cache-control': 's-maxage=60' },
			{ 'cache-control': 'max-age=0' },
			{ 'cache-control': 'max-age=-1' },
			{ 'cache-control': 'max-age=60, max-age=120' },
			{ 'cache-control': 'max-age=60', vary: '*' },
			{ 'cache-control': 'max-age=60', 'content-type': 'text/event-stream' },
			{ 'cache-control': 'max-age=60', 'content-type': 'Text/Event-Stream; charset=utf-8' }
		])
	)('does not cache responses with %j', async (headers) => {
		const { storage, operations } = memory_storage();
		const response = new Response('uncacheable', { headers });
		const clone = vi.spyOn(response, 'clone');
		const fetch = vi.fn().mockResolvedValueOnce(response).mockRejectedValue(offline_error);
		const { handle } = create(fetch, storage);
		expect(await handle(new Request(query_url))).toBe(response);
		await expect(handle(new Request(query_url))).rejects.toBe(offline_error);
		expect(clone).not.toHaveBeenCalled();
		expect(operations).not.toContain('put');
	});

	test('a successful no-store response revokes an older cached value', async () => {
		const { storage } = memory_storage();
		const response = new Response('revoked', { headers: { 'cache-control': 'no-store' } });
		const fetch = vi
			.fn()
			.mockResolvedValueOnce(cacheable('previous value'))
			.mockResolvedValueOnce(response)
			.mockRejectedValue(offline_error);
		const { handle } = create(fetch, storage);
		await handle(new Request(query_url));
		expect(await handle(new Request(query_url))).toBe(response);
		await expect(handle(new Request(query_url))).rejects.toBe(offline_error);
	});

	test('a no-store response fences older reads for its key across Vary headers', async () => {
		const { storage } = memory_storage();
		const old_read = deferred();
		const other_read = deferred();
		const old_response = cacheable('older value', { vary: 'Accept-Language' });
		const revoked = new Response('revoked', { headers: { 'cache-control': 'no-store' } });
		const fetch = vi
			.fn()
			.mockReturnValueOnce(old_read.promise)
			.mockReturnValueOnce(other_read.promise)
			.mockResolvedValueOnce(revoked)
			.mockRejectedValue(offline_error);
		const { handle } = create(fetch, storage);
		const request = new Request(query_url, { headers: { 'accept-language': 'en' } });
		const other_request = new Request(`${query_url}-other`);
		const old_result = handle(request);
		const other_result = handle(other_request);

		expect(await handle(new Request(query_url, { headers: { 'accept-language': 'ko' } }))).toBe(
			revoked
		);
		old_read.resolve(old_response);
		other_read.resolve(cacheable('unrelated value'));
		expect(await old_result).toBe(old_response);
		await other_result;

		await expect(handle(request)).rejects.toBe(offline_error);
		expect(await (await handle(other_request)).text()).toBe('unrelated value');
	});

	test('revocation fences an in-progress cached fallback before deletion can run', async () => {
		const { storage } = memory_storage();
		const fetch = vi.fn().mockResolvedValueOnce(cacheable('previous value'));
		const { handle } = create(fetch, storage);
		await handle(new Request(query_url));

		const open = storage.open.getMockImplementation();
		if (!open) throw new Error('Expected the memory cache implementation');
		const matching = deferred();
		const finish_match = deferred();
		storage.open.mockImplementation(async (name) => {
			const cache = await open(name);
			const match = cache.match;
			cache.match = vi.fn(async (...args) => {
				matching.resolve(undefined);
				await finish_match.promise;
				return match(...args);
			});
			return cache;
		});

		const revoking = deferred();
		fetch.mockRejectedValueOnce(offline_error).mockReturnValueOnce(revoking.promise);
		const fallback = handle(new Request(query_url));
		const rejected = expect(fallback).rejects.toBe(offline_error);
		await matching.promise;
		const revoke = handle(new Request(query_url));
		const response = new Response('revoked', { headers: { 'cache-control': 'no-store' } });
		revoking.resolve(response);
		await Promise.resolve();
		finish_match.resolve(undefined);

		await rejected;
		expect(await revoke).toBe(response);
	});

	test('a read started after revocation can opt the same key back into caching', async () => {
		const { storage } = memory_storage();
		const old_read = deferred();
		const fetch = vi
			.fn()
			.mockReturnValueOnce(old_read.promise)
			.mockResolvedValueOnce(new Response('revoked', { headers: { 'cache-control': 'no-store' } }))
			.mockResolvedValueOnce(cacheable('new opt-in'))
			.mockRejectedValue(offline_error);
		const { handle } = create(fetch, storage);
		const old_result = handle(new Request(query_url));
		await handle(new Request(query_url));
		await handle(new Request(query_url));
		old_read.resolve(cacheable('older value'));
		await old_result;

		expect(await (await handle(new Request(query_url))).text()).toBe('new opt-in');
	});

	test('cancellation after a no-store response does not skip its queued cache deletion', async () => {
		const { storage } = memory_storage();
		const fetch = vi.fn().mockResolvedValueOnce(cacheable('previous value'));
		const { handle } = create(fetch, storage);
		await handle(new Request(query_url));

		const open = storage.open.getMockImplementation();
		if (!open) throw new Error('Expected the memory cache implementation');
		const putting = deferred();
		const finish_put = deferred();
		storage.open.mockImplementation(async (name) => {
			const cache = await open(name);
			const put = cache.put;
			cache.put = vi.fn(async (...args) => {
				putting.resolve(undefined);
				await finish_put.promise;
				return put(...args);
			});
			return cache;
		});

		const revoking = deferred();
		fetch
			.mockResolvedValueOnce(cacheable('unrelated value'))
			.mockReturnValueOnce(revoking.promise)
			.mockRejectedValue(offline_error);
		const other_request = new Request(`${query_url}-other`);
		const pending_put = handle(other_request);
		await putting.promise;
		const controller = new AbortController();
		const reason = new DOMException('Navigation cancelled', 'AbortError');
		const revoked = handle(new Request(query_url, { signal: controller.signal }));
		const rejected = expect(revoked).rejects.toBe(reason);
		revoking.resolve(new Response('revoked', { headers: { 'cache-control': 'no-store' } }));
		await Promise.resolve();
		controller.abort(reason);
		finish_put.resolve(undefined);
		await pending_put;
		await rejected;

		await expect(handle(new Request(query_url))).rejects.toBe(offline_error);
		expect(await (await handle(other_request)).text()).toBe('unrelated value');
	});

	test('preserves an HTTP error without falling back to an earlier cached success', async () => {
		const { storage } = memory_storage();
		const response = new Response('unavailable', { status: 503 });
		const fetch = vi
			.fn()
			.mockResolvedValueOnce(cacheable())
			.mockResolvedValueOnce(response)
			.mockRejectedValue(offline_error);
		const { handle } = create(fetch, storage);
		await handle(new Request(query_url));
		expect(await handle(new Request(query_url))).toBe(response);
		await expect(handle(new Request(query_url))).rejects.toBe(offline_error);
	});
});

test('never clones or reads a cache for live queries, even with the same URL cached', async () => {
	const { storage, operations } = memory_storage();
	const stream = new Response('data: live\n\n', {
		headers: { 'content-type': 'text/event-stream', 'cache-control': 'max-age=60' }
	});
	const clone = vi.spyOn(stream, 'clone');
	const fetch = vi
		.fn()
		.mockResolvedValueOnce(cacheable())
		.mockResolvedValueOnce(stream)
		.mockRejectedValue(offline_error);
	const { handle } = create(fetch, storage);
	await handle(new Request(query_url));
	const operation_count = operations.length;
	const request = new Request(query_url, { headers: { accept: 'text/event-stream' } });
	expect(await handle(request)).toBe(stream);
	await expect(handle(request)).rejects.toBe(offline_error);
	expect(clone).not.toHaveBeenCalled();
	expect(stream.bodyUsed).toBe(false);
	expect(operations).toHaveLength(operation_count);
});

test('honors max-age expiry without extending freshness during offline reads', async () => {
	vi.useFakeTimers();
	vi.setSystemTime(new Date('2026-10-26T00:00:00Z'));
	const { storage } = memory_storage();
	const fetch = vi.fn().mockResolvedValueOnce(cacheable()).mockRejectedValue(offline_error);
	const { handle } = create(fetch, storage);
	await handle(new Request(query_url));
	vi.setSystemTime(new Date('2026-10-26T00:00:59Z'));
	const fresh = await handle(new Request(query_url));
	expect(fresh.headers.get('age')).toBe('59');
	vi.setSystemTime(new Date('2026-10-26T00:01:00Z'));
	await expect(handle(new Request(query_url))).rejects.toBe(offline_error);
});

test('counts upstream Age and Date toward max-age', async () => {
	vi.useFakeTimers();
	vi.setSystemTime(new Date('2026-10-26T00:00:30Z'));
	const { storage } = memory_storage();
	const fetch = vi
		.fn()
		.mockResolvedValueOnce(
			cacheable('old origin value', { age: '40', date: 'Mon, 26 Oct 2026 00:00:00 GMT' })
		)
		.mockRejectedValue(offline_error);
	const { handle } = create(fetch, storage);
	await handle(new Request(query_url));
	vi.setSystemTime(new Date('2026-10-26T00:00:49Z'));
	expect((await handle(new Request(query_url))).headers.get('age')).toBe('59');
	vi.setSystemTime(new Date('2026-10-26T00:00:50Z'));
	await expect(handle(new Request(query_url))).rejects.toBe(offline_error);
});

test('isolates account scopes, deployment versions, query payloads, and Vary headers', async () => {
	const { storage } = memory_storage();
	const fetch = vi
		.fn()
		.mockResolvedValueOnce(cacheable('account one', { vary: 'Accept-Language' }))
		.mockRejectedValue(offline_error);
	const first = create(fetch, storage);
	await first.handle(new Request(query_url, { headers: { 'accept-language': 'en' } }));
	const second = create(fetch, storage, { scope: 'account-two' });
	const next_version = create(fetch, storage, { cacheName: 'test-version-2' });
	await expect(second.handle(new Request(query_url))).rejects.toBe(offline_error);
	await expect(next_version.handle(new Request(query_url))).rejects.toBe(offline_error);
	await expect(first.handle(new Request(`${query_url}-different`))).rejects.toBe(offline_error);
	await expect(
		first.handle(new Request(query_url, { headers: { 'accept-language': 'ko' } }))
	).rejects.toBe(offline_error);
	expect(
		await (
			await first.handle(new Request(query_url, { headers: { 'accept-language': 'en' } }))
		).text()
	).toBe('account one');
});

describe('mutation invalidation', () => {
	test.each(['remote', 'action'])(
		'invalidates before and after a %s without replaying it',
		async (kind) => {
			const { storage, namespaces, operations } = memory_storage();
			const fetch = vi.fn().mockResolvedValueOnce(cacheable());
			const { handle } = create(fetch, storage);
			await handle(new Request(query_url));
			const error = new TypeError('The response was lost after the server accepted the write');
			const request = new Request(
				kind === 'remote' ? 'https://example.com/app/remote/update' : 'https://example.com/items',
				{
					method: 'POST',
					body: 'write once',
					headers: kind === 'action' ? { 'x-sveltekit-action': 'true' } : {}
				}
			);
			fetch.mockImplementationOnce(async (received) => {
				expect(namespaces.size).toBe(0);
				expect(received).toBe(request);
				expect(await received.text()).toBe('write once');
				throw error;
			});
			await expect(handle(request)).rejects.toBe(error);
			expect(fetch).toHaveBeenCalledTimes(2);
			expect(operations.filter((op) => op === 'invalidate')).toHaveLength(2);
			fetch.mockRejectedValue(offline_error);
			await expect(handle(new Request(query_url))).rejects.toBe(offline_error);
		}
	);

	test('a pending GET cannot reinsert data after a mutation completes', async () => {
		const { storage, operations } = memory_storage();
		const old_read = deferred();
		const fetch = vi
			.fn()
			.mockReturnValueOnce(old_read.promise)
			.mockResolvedValueOnce(new Response('accepted'))
			.mockRejectedValue(offline_error);
		const { handle } = create(fetch, storage);
		const old_result = handle(new Request(query_url));
		await handle(new Request('https://example.com/app/remote/update', { method: 'POST' }));
		old_read.resolve(cacheable('stale before mutation'));
		expect(await (await old_result).text()).toBe('stale before mutation');
		expect(operations).not.toContain('put');
		await expect(handle(new Request(query_url))).rejects.toBe(offline_error);
	});

	test('a GET started while a mutation is pending cannot populate the cache', async () => {
		const { storage, operations } = memory_storage();
		const mutation = deferred();
		const entered = deferred();
		const during_mutation = deferred();
		const fetch = vi
			.fn()
			.mockImplementationOnce(() => {
				entered.resolve(undefined);
				return mutation.promise;
			})
			.mockReturnValueOnce(during_mutation.promise)
			.mockRejectedValue(offline_error);
		const { handle } = create(fetch, storage);
		const write = handle(new Request('https://example.com/app/remote/update', { method: 'POST' }));
		await entered.promise;
		const read = handle(new Request(query_url));
		mutation.resolve(new Response('accepted'));
		await write;
		during_mutation.resolve(cacheable('possibly stale'));
		await read;
		expect(operations).not.toContain('put');
		await expect(handle(new Request(query_url))).rejects.toBe(offline_error);
	});

	test('serializes an in-progress cache put before namespace invalidation', async () => {
		const { storage, operations } = memory_storage();
		const open = storage.open.getMockImplementation();
		if (!open) throw new Error('Expected the memory cache implementation');
		const putting = deferred();
		const finish_put = deferred();
		storage.open.mockImplementation(async (name) => {
			const cache = await open(name);
			const put = cache.put;
			cache.put = vi.fn(async (...args) => {
				putting.resolve(undefined);
				await finish_put.promise;
				return put(...args);
			});
			return cache;
		});
		const fetch = vi
			.fn()
			.mockResolvedValueOnce(cacheable())
			.mockResolvedValueOnce(new Response('accepted'))
			.mockRejectedValue(offline_error);
		const { handle } = create(fetch, storage);
		const read = handle(new Request(query_url));
		await putting.promise;
		const write = handle(new Request('https://example.com/app/remote/update', { method: 'POST' }));
		finish_put.resolve(undefined);
		await Promise.all([read, write]);
		expect(operations).toEqual(['put', 'invalidate', 'invalidate']);
		await expect(handle(new Request(query_url))).rejects.toBe(offline_error);
	});

	test('manual invalidation fences pending GETs and does not affect a different scope', async () => {
		const { storage } = memory_storage();
		const other = create(
			vi.fn().mockResolvedValueOnce(cacheable('other account')).mockRejectedValue(offline_error),
			storage,
			{ scope: 'other-account' }
		);
		await other.handle(new Request(query_url));
		const pending = deferred();
		const fetch = vi.fn().mockReturnValueOnce(pending.promise).mockRejectedValue(offline_error);
		const { handle, invalidate } = create(fetch, storage);
		const read = handle(new Request(query_url));
		await invalidate();
		pending.resolve(cacheable());
		await read;
		await expect(handle(new Request(query_url))).rejects.toBe(offline_error);
		expect(await (await other.handle(new Request(query_url))).text()).toBe('other account');
	});
});

test('storage denial preserves the online response and original offline failure', async () => {
	const { storage } = memory_storage();
	storage.open.mockRejectedValue(new DOMException('Storage unavailable', 'SecurityError'));
	const response = cacheable();
	const fetch = vi.fn().mockResolvedValueOnce(response).mockRejectedValue(offline_error);
	const { handle } = create(fetch, storage);
	expect(await handle(new Request(query_url))).toBe(response);
	await expect(handle(new Request(query_url))).rejects.toBe(offline_error);
	expect(storage.open).toHaveBeenCalledTimes(1);
});

test('failed namespace deletion never prevents or replays a mutation', async () => {
	const { storage } = memory_storage();
	const response = new Response('accepted');
	const fetch = vi.fn().mockResolvedValueOnce(cacheable()).mockResolvedValueOnce(response);
	const { handle } = create(fetch, storage);
	await handle(new Request(query_url));
	storage.delete.mockRejectedValue(new Error('Deletion denied'));
	const request = new Request('https://example.com/app/remote/update', { method: 'POST' });
	expect(await handle(request)).toBe(response);
	expect(fetch).toHaveBeenCalledTimes(2);
	fetch.mockRejectedValue(offline_error);
	await expect(handle(new Request(query_url))).rejects.toBe(offline_error);
});

test('preserves aborted requests instead of returning a cached value', async () => {
	const { storage } = memory_storage();
	const fetch = vi.fn().mockResolvedValueOnce(cacheable());
	const { handle } = create(fetch, storage);
	await handle(new Request(query_url));
	const controller = new AbortController();
	const reason = new Error('Navigation cancelled');
	controller.abort(reason);
	await expect(handle(new Request(query_url, { signal: controller.signal }))).rejects.toBe(reason);
	expect(fetch).toHaveBeenCalledTimes(1);
	const abort_error = new DOMException('Wrapper cancelled the fetch', 'AbortError');
	fetch.mockRejectedValue(abort_error);
	await expect(handle(new Request(query_url))).rejects.toBe(abort_error);
});

test('ignores cross-origin remotes and ordinary requests', async () => {
	const { storage } = memory_storage();
	const fetch = vi.fn().mockImplementation(() => Promise.resolve(cacheable()));
	const { handle } = create(fetch, storage);
	await handle(new Request('https://other.example/app/remote/items'));
	await handle(new Request('https://example.com/items'));
	expect(storage.open).not.toHaveBeenCalled();
	expect(storage.delete).not.toHaveBeenCalled();
	expect(fetch).toHaveBeenCalledTimes(2);
});

test.each([{ cacheName: '' }, { scope: '' }, { scope: '  ' }])(
	'requires explicit non-empty deployment and account namespaces: %j',
	(options) => {
		const { storage } = memory_storage();
		expect(() => create(vi.fn(), storage, options)).toThrow(TypeError);
	}
);
