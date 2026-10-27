/** @import { FallbackNode, FallbackRoute } from './data.js' */
/** @import { DataFallbackLoad } from './fallback.js' */
import { execFileSync } from 'node:child_process';
import process from 'node:process';
import { afterEach, expect, test, vi } from 'vitest';
import * as devalue from 'devalue';
import { error, redirect } from '@sveltejs/kit';
import { defineParams } from '@sveltejs/kit/params';
import { parse_route_id } from '../../../utils/routing.js';
import { add_data_suffix } from '../../../pathname.js';
import { INVALIDATED_PARAM, TRAILING_SLASH_PARAM } from '../../shared.js';
import { create_data_resolver } from './data.js';

const origin = 'https://example.com';

afterEach(() => {
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

/**
 * @param {string} id
 * @param {(FallbackNode | null)[]} [nodes]
 * @returns {FallbackRoute}
 */
function route(id, nodes = [{ id, kind: 'page', server: true }]) {
	return { id, ...parse_route_id(id), nodes };
}

/**
 * @param {FallbackRoute[]} routes
 * @param {Parameters<typeof create_data_resolver>[1]} [hooks]
 * @param {Parameters<typeof create_data_resolver>[2]} [matchers]
 * @param {Partial<Parameters<typeof create_data_resolver>[3]>} [options]
 */
function resolver(routes, hooks = {}, matchers = {}, options = {}) {
	return create_data_resolver(routes, hooks, matchers, {
		base: '',
		version: 'test-version',
		versionCheck: true,
		origin,
		...options
	});
}

/**
 * @param {string} path
 * @param {{ invalidated?: string; slash?: boolean; signal?: AbortSignal }} [options]
 */
function request(path, { invalidated, slash, signal } = {}) {
	const url = new URL(path, origin);
	url.pathname = add_data_suffix(url.pathname);
	if (invalidated !== undefined) url.searchParams.set(INVALIDATED_PARAM, invalidated);
	if (slash) url.searchParams.set(TRAILING_SLASH_PARAM, '1');
	return new Request(url, { signal });
}

/** @param {Response | null} response */
async function read(response) {
	expect(response).not.toBeNull();
	if (!response) throw new Error('Expected a data response');
	return (await response.text())
		.trim()
		.split('\n')
		.map((line) => JSON.parse(line));
}

test('matches groups and typed params, and tracks only the URL data read by the load', async () => {
	const id = '/(app)/items/[id=integer]';
	const resolve = resolver(
		[route(id)],
		{},
		defineParams({
			integer: /** @param {string} value */ (value) =>
				/^\d+$/.test(value) ? Number(value) : undefined
		}),
		{ base: '/app' }
	);
	const response = await resolve(request('/app/items/42?filter=recent', { invalidated: '1' }), {
		[id]: {
			page: ({ params, url, route, node }) => ({
				id: params.id,
				filter: url.searchParams.get('filter'),
				pathname: url.pathname,
				route: route.id,
				node
			})
		}
	});
	const [result] = await read(response);
	expect(devalue.unflatten(result.nodes[0].data)).toEqual({
		id: 42,
		filter: 'recent',
		pathname: '/app/items/42',
		route: id,
		node: { id, kind: 'page' }
	});
	expect(result.nodes[0].uses).toEqual({
		search_params: ['filter'],
		params: ['id'],
		route: 1,
		url: 1
	});
	expect(response?.headers.get('x-sveltekit-version')).toBe('test-version');
	expect(response?.headers.get('cache-control')).toBe('private, no-store');
});

test('continues to the next matching route when a typed matcher rejects a value', async () => {
	const typed = '/items/[id=integer]';
	const plain = '/items/[slug]';
	const load = vi.fn();
	const resolve = resolver(
		[route(typed), route(plain)],
		{},
		defineParams({
			integer: /** @param {string} value */ (value) =>
				/^\d+$/.test(value) ? Number(value) : undefined
		})
	);
	const [result] = await read(
		await resolve(request('/items/welcome'), {
			[typed]: { page: load },
			[plain]: { page: ({ params }) => ({ slug: params.slug }) }
		})
	);
	expect(devalue.unflatten(result.nodes[0].data)).toEqual({ slug: 'welcome' });
	expect(load).not.toHaveBeenCalled();
});

test('does not fall through an unsupported specific route to a lower-precedence route', async () => {
	const load = vi.fn(() => ({ wrong: true }));
	const resolve = resolver([{ ...route('/items/new'), unsupported: true }, route('/items/[slug]')]);
	expect(
		await resolve(request('/items/new'), {
			'/items/new': { page: load },
			'/items/[slug]': { page: load }
		})
	).toBeNull();
	expect(load).not.toHaveBeenCalled();
});

test('checks typed params before declining an unsupported route', async () => {
	const typed = '/items/[id=integer]';
	const plain = '/items/[slug]';
	const load = vi.fn();
	const resolve = resolver(
		[{ ...route(typed), unsupported: true }, route(plain)],
		{},
		defineParams({
			integer: /** @param {string} value */ (value) =>
				/^\d+$/.test(value) ? Number(value) : undefined
		})
	);
	expect(await resolve(request('/items/42'), { [plain]: { page: load } })).toBeNull();
	expect(load).not.toHaveBeenCalled();
	const [result] = await read(
		await resolve(request('/items/welcome'), {
			[plain]: { page: ({ params }) => ({ slug: params.slug }) }
		})
	);
	expect(devalue.unflatten(result.nodes[0].data)).toEqual({ slug: 'welcome' });
});

test.each([
	new Request('https://other.example/app/items/__data.json'),
	new Request(`${origin}/application/items/__data.json`),
	new Request(`${origin}/app/items`),
	new Request(`${origin}/app/items/__data.json`, { method: 'POST' }),
	new Request(`${origin}/app/unknown/__data.json`)
])('leaves unsupported requests untouched: %s', async (request) => {
	const load = vi.fn();
	const resolve = resolver([route('/items')], {}, {}, { base: '/app' });
	expect(await resolve(request, { '/items': { page: load } })).toBeNull();
	expect(load).not.toHaveBeenCalled();
});

test('reroutes against a clean page URL and keeps the original URL in load', async () => {
	const fetch = vi.fn(() => Promise.resolve(new Response('/app/articles/55')));
	vi.stubGlobal('fetch', fetch);
	const reroute = vi.fn(
		/** @type {import('@sveltejs/kit/hooks').Reroute} */ (
			async ({ url, fetch }) => {
				expect(url.pathname).toBe('/app/translated');
				expect(url.search).toBe('?lang=ko');
				return await (await fetch('lookup')).text();
			}
		)
	);
	const resolve = resolver([route('/articles/[id]')], { reroute }, {}, { base: '/app' });
	const [result] = await read(
		await resolve(request('/app/translated?lang=ko', { invalidated: '1' }), {
			'/articles/[id]': { page: ({ url, params }) => ({ path: url.pathname, id: params.id }) }
		})
	);
	expect(devalue.unflatten(result.nodes[0].data)).toEqual({ path: '/app/translated', id: '55' });
	expect(fetch).toHaveBeenCalledExactlyOnceWith(new URL('/app/lookup', origin), undefined);
});

test('reconstructs trailing slash and .html data URLs', async () => {
	const resolve = resolver([
		route('/items', [{ id: '/items', kind: 'page', server: true, slash: 'ignore' }]),
		route('/index.html')
	]);
	for (const path of ['/items/', '/index.html']) {
		const id = path === '/items/' ? '/items' : path;
		const [result] = await read(
			await resolve(request(path, { slash: path.endsWith('/') }), {
				[id]: { page: ({ url }) => ({ path: url.pathname }) }
			})
		);
		expect(devalue.unflatten(result.nodes[0].data)).toEqual({ path });
	}
});

test.each([
	{ slash: /** @type {const} */ ('always'), requested: '/items', expected: '/items/' },
	{ slash: /** @type {const} */ ('never'), requested: '/items/', expected: '/items' }
])(
	'normalizes load URLs using the route trailingSlash option: $slash',
	async ({ slash, requested, expected }) => {
		const resolve = resolver([
			route('/items', [
				{ id: '/', kind: 'layout', server: false, slash },
				{ id: '/items', kind: 'page', server: true }
			])
		]);
		const [result] = await read(
			await resolve(request(requested, { slash: requested.endsWith('/') }), {
				'/items': { page: ({ url }) => ({ path: url.pathname }) }
			})
		);
		expect(devalue.unflatten(result.nodes[1].data)).toEqual({ path: expected });
	}
);

test('defaults the base root load URL to a trailing slash', async () => {
	const resolve = resolver([route('/')], {}, {}, { base: '/app' });
	const [result] = await read(
		await resolve(request('/app'), {
			'/': { page: ({ url }) => ({ path: url.pathname }) }
		})
	);
	expect(devalue.unflatten(result.nodes[0].data)).toEqual({ path: '/app/' });
});

test.each([
	{ id: '/', slash: /** @type {const} */ ('never') },
	{ id: '/', slash: /** @type {const} */ ('ignore') },
	{ id: '/(group)', slash: undefined },
	{ id: '/(group)', slash: /** @type {const} */ ('never') }
])('forces a trailing slash at the base root for $id with $slash', async ({ id, slash }) => {
	const resolve = resolver(
		[route(id, [{ id, kind: 'page', server: true, slash }])],
		{},
		{},
		{ base: '/app' }
	);
	for (const path of ['/app', '/app/']) {
		const [result] = await read(
			await resolve(request(path, { slash: path.endsWith('/') }), {
				[id]: {
					page: ({ url }) => ({ path: url.pathname, relative: new URL('items', url).pathname })
				}
			})
		);
		expect(devalue.unflatten(result.nodes[0].data)).toEqual({
			path: '/app/',
			relative: '/app/items'
		});
	}
});

test('does not force a trailing slash on a URL rerouted to the base root', async () => {
	const resolve = resolver([route('/')], { reroute: () => '/app/' }, {}, { base: '/app' });
	const [result] = await read(
		await resolve(request('/app/alias'), {
			'/': { page: ({ url }) => ({ path: url.pathname }) }
		})
	);
	expect(devalue.unflatten(result.nodes[0].data)).toEqual({ path: '/app/alias' });
});

test('loads skipped ancestors lazily for parent without changing their response positions', async () => {
	const id = '/(app)/items/[id]';
	const root = vi.fn(() => ({ shared: 'root', root: true }));
	const layout = vi.fn(
		/** @type {DataFallbackLoad} */ (
			async ({ parent }) => ({ ...(await parent()), shared: 'layout' })
		)
	);
	const page = vi.fn(
		/** @type {DataFallbackLoad} */ (
			async ({ parent }) => {
				const first = await parent();
				expect(await parent()).toBe(first);
				return { ...first, page: true };
			}
		)
	);
	const resolve = resolver([
		route(id, [
			{ id: '/', kind: 'layout', server: true },
			null,
			{ id: '/(app)/items', kind: 'layout', server: true },
			{ id, kind: 'page', server: true }
		])
	]);
	const [result] = await read(
		await resolve(request('/items/1', { invalidated: '0001' }), {
			'/': { layout: root },
			'/(app)/items': { layout },
			[id]: { page }
		})
	);
	expect(result.nodes.slice(0, 3)).toEqual([{ type: 'skip' }, { type: 'skip' }, { type: 'skip' }]);
	expect(devalue.unflatten(result.nodes[3].data)).toEqual({
		shared: 'layout',
		root: true,
		page: true
	});
	expect(result.nodes[3].uses).toEqual({ parent: 1 });
	expect(root).toHaveBeenCalledOnce();
	expect(layout).toHaveBeenCalledOnce();
	expect(page).toHaveBeenCalledOnce();
});

test('declines missing required nodes before invoking any load', async () => {
	const root = vi.fn(() => ({ root: true }));
	const resolve = resolver([
		route('/items', [
			{ id: '/', kind: 'layout', server: true },
			{ id: '/items', kind: 'page', server: true }
		])
	]);
	expect(await resolve(request('/items'), { '/': { layout: root } })).toBeNull();
	expect(root).not.toHaveBeenCalled();
});

test('declines when parent requires a missing non-invalidated ancestor', async () => {
	const resolve = resolver([
		route('/items', [
			{ id: '/', kind: 'layout', server: true },
			{ id: '/items', kind: 'page', server: true }
		])
	]);
	expect(
		await resolve(request('/items', { invalidated: '01' }), {
			'/items': { page: async ({ parent }) => ({ ...(await parent()), page: true }) }
		})
	).toBeNull();
});

test('streams fallback values through the custom transport', async () => {
	class Label {
		/** @param {string} text */
		constructor(text) {
			this.text = text;
		}
	}
	const transport = {
		Label: {
			encode: (/** @type {any} */ value) => value instanceof Label && [value.text],
			decode: (/** @type {string[]} */ [text]) => new Label(text)
		}
	};
	const resolve = resolver([route('/items')], { transport });
	const response = await resolve(request('/items'), {
		'/items': {
			page: () => ({ initial: new Label('now'), later: Promise.resolve(new Label('later')) })
		}
	});
	const [initial, chunk] = await read(response);
	expect(response?.headers.get('content-type')).toBe('text/sveltekit-data');
	expect(
		devalue.unflatten(initial.nodes[0].data, { Label: transport.Label.decode, Promise: (id) => id })
	).toEqual({ initial: new Label('now'), later: 1 });
	expect(chunk).toMatchObject({ type: 'chunk', id: 1 });
	expect(devalue.unflatten(chunk.data, { Label: transport.Label.decode })).toEqual(
		new Label('later')
	);
});

test.each(['data', 'redirect'])(
	'handles deferred rejections before a later load completes with %s',
	(outcome) => {
		// A separate process observes actual unhandled rejections without interfering with Vitest's
		// own listener. The data case yields while loading the child; the redirect case discards
		// the parent response before its deferred value rejects.
		const output = execFileSync(
			process.execPath,
			[
				'--unhandled-rejections=strict',
				'--input-type=module',
				'--eval',
				`
					import { create_data_resolver } from ${JSON.stringify(new URL('./data.js', import.meta.url).href)};
					const resolve = create_data_resolver([{
						id: '/items', pattern: /^\\/items$/, params: [], nodes: [
							{ id: '/', kind: 'layout', server: true },
							{ id: '/items', kind: 'page', server: true }
						]
					}], {}, {}, { base: '', version: 'test', versionCheck: true, origin: 'https://example.com' });
					const response = await resolve(new Request('https://example.com/items/__data.json'), {
						'/': { layout: () => ({
							later: new Promise((_, reject) => setImmediate(() => reject(new Error('Deferred failure'))))
						}) },
						'/items': { page: async () => {
							${outcome === 'data' ? 'await new Promise(setImmediate); return { ready: true };' : "throw { status: 307, location: '/login' };"}
						} }
					});
					process.stdout.write(await response.text());
					await new Promise(setImmediate);
				`
			],
			{ encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
		);
		const result = output
			.trim()
			.split('\n')
			.map((line) => JSON.parse(line));
		if (outcome === 'redirect') {
			expect(result).toEqual([{ type: 'redirect', status: 307, location: '/login' }]);
		} else {
			expect(result).toHaveLength(2);
			expect(devalue.unflatten(result[0].nodes[1].data)).toEqual({ ready: true });
			expect(result[1]).toMatchObject({ type: 'chunk', id: 1 });
			expect(devalue.unflatten(result[1].error)).toEqual({
				status: 500,
				message: 'Deferred failure'
			});
		}
	}
);

test('returns redirect and error envelopes with the normal data-navigation status', async () => {
	const resolve = resolver([route('/items')]);
	const redirected = await resolve(request('/items'), {
		'/items': { page: () => redirect(307, '/login') }
	});
	expect(redirected?.status).toBe(200);
	expect(await read(redirected)).toEqual([{ type: 'redirect', status: 307, location: '/login' }]);

	const failed = await resolve(request('/items'), {
		'/items': { page: () => error(401, 'Sign in') }
	});
	expect(failed?.status).toBe(200);
	expect(await read(failed)).toEqual([
		{ type: 'data', nodes: [{ type: 'error', error: { status: 401, message: 'Sign in' } }] }
	]);
});

test('returns a JSON error response when initial fallback data cannot be serialized', async () => {
	const resolve = resolver([route('/items')]);
	const response = await resolve(request('/items'), {
		'/items': { page: () => ({ invalid: () => {} }) }
	});
	expect(response?.status).toBe(500);
	expect(response?.headers.get('content-type')).toBe('application/json');
	expect(response?.headers.get('cache-control')).toBe('private, no-store');
	expect(response?.headers.get('x-sveltekit-version')).toBe('test-version');
	expect(await response?.json()).toEqual({
		status: 500,
		message: expect.stringContaining('Cannot stringify a function')
	});
});

test('keeps deferred serialization failures in the response stream', async () => {
	const resolve = resolver([route('/items')]);
	const response = await resolve(request('/items'), {
		'/items': { page: () => ({ later: Promise.resolve(() => {}) }) }
	});
	expect(response?.status).toBe(200);
	expect(response?.headers.get('content-type')).toBe('text/sveltekit-data');
	const [initial, chunk] = await read(response);
	expect(initial.type).toBe('data');
	expect(chunk).toMatchObject({ type: 'chunk', id: 1 });
	expect(devalue.unflatten(chunk.error)).toEqual({
		status: 500,
		message: expect.stringContaining('Cannot stringify a function')
	});
});

test('rejects cancelled requests before loads and after an in-flight load', async () => {
	const controller = new AbortController();
	const reason = new Error('navigation cancelled');
	const load = vi.fn();
	const resolve = resolver([route('/items')]);
	controller.abort(reason);
	await expect(
		resolve(request('/items', { signal: controller.signal }), { '/items': { page: load } })
	).rejects.toBe(reason);
	expect(load).not.toHaveBeenCalled();

	const running = new AbortController();
	const started = Promise.withResolvers();
	const completed = Promise.withResolvers();
	const response = resolve(request('/items', { signal: running.signal }), {
		'/items': {
			page: () => {
				started.resolve(undefined);
				return completed.promise;
			}
		}
	});
	await started.promise;
	running.abort(reason);
	completed.resolve({ stale: true });
	await expect(response).rejects.toBe(reason);
});

test('server retries preserve the original request and combine caller cancellation', async () => {
	const controller = new AbortController();
	const fetch = vi.fn((/** @type {Request} */ _request, /** @type {RequestInit} */ init) => {
		const signal = /** @type {AbortSignal} */ (init.signal);
		expect(signal.aborted).toBe(false);
		controller.abort(new Error('retry cancelled'));
		return Promise.reject(signal.reason);
	});
	vi.stubGlobal('fetch', fetch);
	const original = request('/items?filter=recent', { invalidated: '1' });
	const resolve = resolver([route('/items')]);
	const [result] = await read(
		await resolve(original, {
			'/items': {
				page: async ({ server }) => {
					try {
						await server({ signal: controller.signal, timeout: 1000 });
					} catch (error) {
						return { message: /** @type {Error} */ (error).message };
					}
					return { unexpected: true };
				}
			}
		})
	);
	expect(devalue.unflatten(result.nodes[0].data)).toEqual({ message: 'retry cancelled' });
	expect(fetch).toHaveBeenCalledExactlyOnceWith(original, { signal: expect.any(AbortSignal) });
});

test('server retry timeouts abort fetch and release the timer', async () => {
	vi.useFakeTimers();
	const started = Promise.withResolvers();
	vi.stubGlobal(
		'fetch',
		(/** @type {Request} */ _request, /** @type {RequestInit} */ init) =>
			new Promise((_resolve, reject) => {
				const signal = /** @type {AbortSignal} */ (init.signal);
				signal.addEventListener('abort', () => reject(signal.reason), { once: true });
				started.resolve(undefined);
			})
	);
	const resolve = resolver([route('/items')]);
	const response = resolve(request('/items'), {
		'/items': {
			page: async ({ server }) => {
				try {
					await server({ timeout: 10 });
				} catch (error) {
					return { name: /** @type {Error} */ (error).name };
				}
				return { unexpected: true };
			}
		}
	});
	await started.promise;
	await vi.advanceTimersByTimeAsync(10);
	const [result] = await read(await response);
	expect(devalue.unflatten(result.nodes[0].data)).toEqual({ name: 'TimeoutError' });
	expect(vi.getTimerCount()).toBe(0);
});
