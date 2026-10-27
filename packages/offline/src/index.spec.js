import { describe, expect, test, vi } from 'vitest';
import { createOfflineHandler } from './index.js';

const handlers = { '/items': { page: () => ({ items: ['local'] }) } };

describe('network-first read policy', () => {
	test('returns the network response without invoking local loaders', async () => {
		const request = new Request('https://example.com/items/__data.json');
		const response = new Response('server data');
		const fetch = vi.fn().mockResolvedValue(response);
		const resolve_data = vi.fn();
		const handle = createOfflineHandler({ resolveData: resolve_data, handlers, fetch });

		expect(await handle(request)).toBe(response);
		expect(fetch).toHaveBeenCalledExactlyOnceWith(request);
		expect(resolve_data).not.toHaveBeenCalled();
		expect(response.bodyUsed).toBe(false);
	});

	test('uses the injected resolver after a rejected network request', async () => {
		const request = new Request('https://example.com/items/__data.json');
		const response = new Response('local data');
		const fetch = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
		const resolve_data = vi.fn().mockResolvedValue(response);
		const handle = createOfflineHandler({ resolveData: resolve_data, handlers, fetch });

		expect(await handle(request)).toBe(response);
		expect(fetch).toHaveBeenCalledExactlyOnceWith(request);
		expect(resolve_data).toHaveBeenCalledExactlyOnceWith(request, handlers);
		expect(fetch.mock.invocationCallOrder[0]).toBeLessThan(
			resolve_data.mock.invocationCallOrder[0]
		);
		expect(response.bodyUsed).toBe(false);
	});

	test('keeps the original network failure when no local loader matches', async () => {
		const error = new TypeError('Failed to fetch');
		const fetch = vi.fn().mockRejectedValue(error);
		const resolve_data = vi.fn().mockResolvedValue(null);
		const handle = createOfflineHandler({ resolveData: resolve_data, handlers, fetch });

		await expect(handle(new Request('https://example.com/asset.png'))).rejects.toBe(error);
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(resolve_data).toHaveBeenCalledTimes(1);
	});

	test.each([404, 503])('returns HTTP %i without substituting local data', async (status) => {
		const response = new Response('server response', { status });
		const fetch = vi.fn().mockResolvedValue(response);
		const resolve_data = vi.fn();
		const handle = createOfflineHandler({ resolveData: resolve_data, handlers, fetch });

		expect(await handle(new Request('https://example.com/items/__data.json'))).toBe(response);
		expect(resolve_data).not.toHaveBeenCalled();
	});

	test('propagates a loader rejection without retrying the network', async () => {
		const error = new Error('Local storage unavailable');
		const fetch = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
		const resolve_data = vi.fn().mockRejectedValue(error);
		const handle = createOfflineHandler({ resolveData: resolve_data, handlers, fetch });

		await expect(handle(new Request('https://example.com/items/__data.json'))).rejects.toBe(error);
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(resolve_data).toHaveBeenCalledTimes(1);
	});
});

describe('worker-first read policy', () => {
	test('returns local data without a network request', async () => {
		const request = new Request('https://example.com/items/__data.json');
		const response = new Response('local data');
		const fetch = vi.fn();
		const resolve_data = vi.fn().mockResolvedValue(response);
		const handle = createOfflineHandler({
			resolveData: resolve_data,
			handlers,
			fetch,
			strategy: 'worker-first'
		});

		expect(await handle(request)).toBe(response);
		expect(resolve_data).toHaveBeenCalledExactlyOnceWith(request, handlers);
		expect(fetch).not.toHaveBeenCalled();
	});

	test('uses the original request for unmatched data', async () => {
		const request = new Request('https://example.com/asset.png');
		const response = new Response('asset');
		const fetch = vi.fn().mockResolvedValue(response);
		const resolve_data = vi.fn().mockResolvedValue(null);
		const handle = createOfflineHandler({
			resolveData: resolve_data,
			handlers,
			fetch,
			strategy: 'worker-first'
		});

		expect(await handle(request)).toBe(response);
		expect(fetch).toHaveBeenCalledExactlyOnceWith(request);
		expect(resolve_data).toHaveBeenCalledExactlyOnceWith(request, handlers);
	});

	test('does not invoke local data again when the unmatched network request rejects', async () => {
		const error = new TypeError('Failed to fetch');
		const fetch = vi.fn().mockRejectedValue(error);
		const resolve_data = vi.fn().mockResolvedValue(null);
		const handle = createOfflineHandler({
			resolveData: resolve_data,
			handlers,
			fetch,
			strategy: 'worker-first'
		});

		await expect(handle(new Request('https://example.com/asset.png'))).rejects.toBe(error);
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(resolve_data).toHaveBeenCalledTimes(1);
	});

	test('propagates a local loader rejection without issuing a network request', async () => {
		const error = new Error('Local storage unavailable');
		const fetch = vi.fn();
		const resolve_data = vi.fn().mockRejectedValue(error);
		const handle = createOfflineHandler({
			resolveData: resolve_data,
			handlers,
			fetch,
			strategy: 'worker-first'
		});

		await expect(handle(new Request('https://example.com/items/__data.json'))).rejects.toBe(error);
		expect(fetch).not.toHaveBeenCalled();
	});
});

/** @type {Array<'network-first' | 'worker-first'>} */
const strategies = ['network-first', 'worker-first'];

describe.each(strategies)('%s safety', (strategy) => {
	test.each(['POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'])(
		'passes %s requests through without invoking local loaders',
		async (method) => {
			const request = new Request('https://example.com/items', {
				method,
				body: method === 'HEAD' ? undefined : 'submitted data'
			});
			const response = new Response('server result');
			const fetch = vi.fn(async (/** @type {Request} */ received) => {
				expect(received).toBe(request);
				expect(received.bodyUsed).toBe(false);
				if (method !== 'HEAD') expect(await received.text()).toBe('submitted data');
				return response;
			});
			const resolve_data = vi.fn();
			const handle = createOfflineHandler({ resolveData: resolve_data, handlers, fetch, strategy });

			expect(await handle(request)).toBe(response);
			expect(fetch).toHaveBeenCalledExactlyOnceWith(request);
			expect(resolve_data).not.toHaveBeenCalled();
		}
	);

	test.each(['POST', 'PUT'])('never replays or substitutes a failed %s', async (method) => {
		const request = new Request('https://example.com/items', { method, body: 'submitted data' });
		const error = new TypeError('The server may already have accepted this write');
		const fetch = vi.fn().mockRejectedValue(error);
		const resolve_data = vi.fn();
		const handle = createOfflineHandler({ resolveData: resolve_data, handlers, fetch, strategy });

		await expect(handle(request)).rejects.toBe(error);
		expect(fetch).toHaveBeenCalledExactlyOnceWith(request);
		expect(resolve_data).not.toHaveBeenCalled();
		expect(request.bodyUsed).toBe(false);
	});

	test('does no work for an already aborted request', async () => {
		const controller = new AbortController();
		const request = new Request('https://example.com/items/__data.json', {
			signal: controller.signal
		});
		const reason = new Error('Navigation cancelled');
		controller.abort(reason);
		const fetch = vi.fn();
		const resolve_data = vi.fn();
		const handle = createOfflineHandler({ resolveData: resolve_data, handlers, fetch, strategy });

		await expect(handle(request)).rejects.toBe(reason);
		expect(fetch).not.toHaveBeenCalled();
		expect(resolve_data).not.toHaveBeenCalled();
	});

	test('does not return local data after cancellation during a local read', async () => {
		const controller = new AbortController();
		const request = new Request('https://example.com/items/__data.json', {
			signal: controller.signal
		});
		const reason = new DOMException('Navigation cancelled', 'AbortError');
		const fetch = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
		const resolve_data = vi.fn(() => {
			controller.abort(reason);
			return Promise.resolve(new Response('local data'));
		});
		const handle = createOfflineHandler({ resolveData: resolve_data, handlers, fetch, strategy });

		await expect(handle(request)).rejects.toBe(reason);
		expect(fetch).toHaveBeenCalledTimes(strategy === 'network-first' ? 1 : 0);
		expect(resolve_data).toHaveBeenCalledTimes(1);
	});
});

test('does not replace an aborted network request with local data', async () => {
	const controller = new AbortController();
	const request = new Request('https://example.com/items/__data.json', {
		signal: controller.signal
	});
	const reason = new Error('Navigation cancelled');
	const fetch = vi.fn(() => {
		controller.abort(reason);
		return Promise.reject(reason);
	});
	const resolve_data = vi.fn();
	const handle = createOfflineHandler({ resolveData: resolve_data, handlers, fetch });

	await expect(handle(request)).rejects.toBe(reason);
	expect(resolve_data).not.toHaveBeenCalled();
});

test('preserves network AbortError even when a wrapper uses its own signal', async () => {
	const error = new DOMException('Request cancelled', 'AbortError');
	const fetch = vi.fn().mockRejectedValue(error);
	const resolve_data = vi.fn();
	const handle = createOfflineHandler({ resolveData: resolve_data, handlers, fetch });

	await expect(handle(new Request('https://example.com/items/__data.json'))).rejects.toBe(error);
	expect(resolve_data).not.toHaveBeenCalled();
});
