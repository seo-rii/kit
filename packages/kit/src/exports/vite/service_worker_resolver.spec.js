import * as devalue from 'devalue';
import { expect, test, vi } from 'vitest';
import { create_service_worker_resolver } from './service_worker_resolver.js';

/**
 * @param {{
 *   hooks?: import('types').ManifestData['hooks'];
 *   route_id?: string;
 *   pattern?: RegExp;
 *   trailing_slash?: import('types').TrailingSlash;
 *   worker_file?: string;
 * }} options
 * @returns {import('types').ManifestData}
 */
function create_manifest({
	hooks = { client: null, server: null, universal: null },
	route_id = '/target',
	pattern = /^\/target\/?$/,
	trailing_slash,
	worker_file = 'src/routes/target/+page.worker.js'
} = {}) {
	const node = {
		depth: 0,
		server: 'src/routes/target/+page.server.js',
		worker: worker_file,
		page_options: trailing_slash ? { trailingSlash: trailing_slash } : null
	};

	return {
		assets: [],
		hooks,
		matchers: {},
		nodes: [node],
		routes: [
			{
				id: route_id,
				parent: null,
				segment: route_id.slice(1),
				pattern,
				params: [],
				page: {
					layouts: [],
					errors: [],
					leaf: 0
				},
				layout: null,
				error: null,
				leaf: node,
				endpoint: null
			}
		]
	};
}

/**
 * @param {import('types').ManifestData} manifest
 * @param {{
 *   fetch?: typeof fetch;
 *   hooks?: Record<string, any>;
 *   workers: Record<string, Record<string, any>>;
 * }} options
 */
function instantiate_resolver(manifest, { fetch = globalThis.fetch, hooks = {}, workers }) {
	const source = create_service_worker_resolver(manifest)
		.replace("import * as devalue from 'devalue';", '')
		.replace(
			/^import \* as (worker_\d+) from ("[^"]+");$/gm,
			(_, name, file) => `const ${name} = workers[${file}];`
		)
		.replace(/^import \* as universal_hooks from "[^"]+";$/m, '')
		.replace('export async function resolve', 'async function resolve');

	const factory = new Function(
		'devalue',
		'workers',
		'universal_hooks',
		'fetch',
		'base',
		`${source}\nreturn { resolve };`
	);

	return factory(devalue, workers, hooks, fetch, '');
}

/** @param {Response} response */
async function read_action_data(response) {
	const result = await response.json();
	if (result.type === 'success' || result.type === 'failure') {
		result.data = devalue.parse(result.data);
	}
	return result;
}

test('only imports matchers used by worker routes', () => {
	const nodes = [
		{
			depth: 0,
			server: 'src/routes/worker/[id=used]/+page.server.js',
			worker: 'src/routes/worker/[id=used]/+page.worker.js'
		},
		{
			depth: 0,
			server: 'src/routes/server/[id=unused]/+page.server.js'
		}
	];

	/** @type {import('types').ManifestData} */
	const manifest_data = {
		assets: [],
		hooks: {
			client: null,
			server: null,
			universal: null
		},
		matchers: {
			used: 'src/params/used.js',
			unused: 'src/params/unused.js'
		},
		nodes,
		routes: [
			{
				id: '/worker/[id=used]',
				parent: null,
				segment: '[id=used]',
				pattern: /^\/worker\/([^/]+?)\/?$/,
				params: [
					{
						name: 'id',
						matcher: 'used',
						optional: false,
						rest: false,
						chained: false
					}
				],
				page: {
					layouts: [],
					errors: [],
					leaf: 0
				},
				layout: null,
				error: null,
				leaf: nodes[0],
				endpoint: null
			},
			{
				id: '/server/[id=unused]',
				parent: null,
				segment: '[id=unused]',
				pattern: /^\/server\/([^/]+?)\/?$/,
				params: [
					{
						name: 'id',
						matcher: 'unused',
						optional: false,
						rest: false,
						chained: false
					}
				],
				page: {
					layouts: [],
					errors: [],
					leaf: 1
				},
				layout: null,
				error: null,
				leaf: nodes[1],
				endpoint: null
			}
		]
	};

	const code = create_service_worker_resolver(manifest_data);

	expect(code).toContain('/src/params/used.js');
	expect(code).not.toContain('/src/params/unused.js');
});

test('serializes worker load errors as data nodes', async () => {
	const manifest = create_manifest();
	const { resolve } = instantiate_resolver(manifest, {
		workers: {
			'/src/routes/target/+page.worker.js': {
				load() {
					throw { status: 404, body: { message: 'worker not found' } };
				}
			}
		}
	});

	const response = await resolve(new Request('https://example.com/target/__data.json'), {
		strategy: 'worker-first'
	});

	expect(response.status).toBe(200);
	expect(await response.json()).toEqual({
		type: 'data',
		nodes: [
			{
				type: 'error',
				status: 404,
				error: { message: 'worker not found' }
			}
		]
	});
});

test('serializes worker load redirects as data redirects', async () => {
	const manifest = create_manifest();
	const { resolve } = instantiate_resolver(manifest, {
		workers: {
			'/src/routes/target/+page.worker.js': {
				load() {
					throw { status: 303, location: '/login' };
				}
			}
		}
	});

	const response = await resolve(new Request('https://example.com/target/__data.json'), {
		strategy: 'worker-first'
	});

	expect(response.status).toBe(200);
	expect(await response.json()).toEqual({ type: 'redirect', location: '/login' });
});

test('applies the universal reroute hook before matching a worker route', async () => {
	/** @type {URL | undefined} */
	let reroute_url;
	const reroute = vi.fn((/** @type {{ url: URL }} */ { url }) => {
		reroute_url = url;
		return '/canonical';
	});
	const manifest = create_manifest({
		hooks: { client: null, server: null, universal: 'src/hooks.js' },
		route_id: '/canonical',
		pattern: /^\/canonical\/?$/
	});
	const { resolve } = instantiate_resolver(manifest, {
		hooks: { reroute },
		workers: {
			'/src/routes/target/+page.worker.js': {
				/** @param {{ route: { id: string }; url: URL }} event */
				load({ route, url }) {
					return { route: route.id, visible_pathname: url.pathname };
				}
			}
		}
	});

	const response = await resolve(new Request('https://example.com/localized/__data.json'), {
		strategy: 'worker-first'
	});
	const body = await response.json();

	expect(reroute).toHaveBeenCalledOnce();
	expect(reroute_url?.pathname).toBe('/localized');
	expect(devalue.unflatten(body.nodes[0].data)).toEqual({
		route: '/canonical',
		visible_pathname: '/localized'
	});
});

test('serializes worker data with universal transport encoders and node slash metadata', async () => {
	class Custom {
		/** @param {string} value */
		constructor(value) {
			this.value = value;
		}
	}

	const manifest = create_manifest({
		hooks: { client: null, server: null, universal: 'src/hooks.js' },
		trailing_slash: 'always'
	});
	const { resolve } = instantiate_resolver(manifest, {
		hooks: {
			transport: {
				Custom: {
					/** @param {unknown} value */
					encode: (value) => value instanceof Custom && value.value
				}
			}
		},
		workers: {
			'/src/routes/target/+page.worker.js': {
				load: () => ({ custom: new Custom('worker data') })
			}
		}
	});

	const response = await resolve(new Request('https://example.com/target/__data.json'), {
		strategy: 'worker-first'
	});
	const body = await response.json();

	expect(body.nodes[0].slash).toBe('always');
	expect(
		devalue.unflatten(body.nodes[0].data, {
			Custom: (value) => ({ decoded: value })
		})
	).toEqual({ custom: { decoded: 'worker data' } });
});

test('serializes worker action data with universal transport encoders', async () => {
	class Custom {
		/** @param {string} value */
		constructor(value) {
			this.value = value;
		}
	}

	const manifest = create_manifest({
		hooks: { client: null, server: null, universal: 'src/hooks.js' }
	});
	const { resolve } = instantiate_resolver(manifest, {
		hooks: {
			transport: {
				Custom: {
					/** @param {unknown} value */
					encode: (value) => value instanceof Custom && value.value
				}
			}
		},
		workers: {
			'/src/routes/target/+page.worker.js': {
				actions: { default: () => ({ custom: new Custom('worker action') }) }
			}
		}
	});
	const request = new Request('https://example.com/target', {
		method: 'POST',
		headers: {
			'content-type': 'application/x-www-form-urlencoded',
			'x-sveltekit-action': 'true'
		},
		body: 'value=test'
	});

	const response = await resolve(request, { strategy: 'worker-first' });
	const result = await response.json();

	expect(
		devalue.parse(result.data, {
			Custom: (value) => ({ decoded: value })
		})
	).toEqual({ custom: { decoded: 'worker action' } });
});

test('serializes worker action failure data with universal transport encoders', async () => {
	class Custom {
		/** @param {string} value */
		constructor(value) {
			this.value = value;
		}
	}

	const manifest = create_manifest({
		hooks: { client: null, server: null, universal: 'src/hooks.js' }
	});
	const { resolve } = instantiate_resolver(manifest, {
		hooks: {
			transport: {
				Custom: {
					/** @param {unknown} value */
					encode: (value) => value instanceof Custom && value.value
				}
			}
		},
		workers: {
			'/src/routes/target/+page.worker.js': {
				actions: {
					default: () => ({
						type: 'failure',
						status: 422,
						data: { custom: new Custom('worker failure') }
					})
				}
			}
		}
	});
	const request = new Request('https://example.com/target', {
		method: 'POST',
		headers: {
			'content-type': 'application/x-www-form-urlencoded',
			'x-sveltekit-action': 'true'
		},
		body: 'value=test'
	});

	const response = await resolve(request, { strategy: 'worker-first' });
	const result = await response.json();

	expect(result.type).toBe('failure');
	expect(result.status).toBe(422);
	expect(
		devalue.parse(result.data, {
			Custom: (value) => ({ decoded: value })
		})
	).toEqual({ custom: { decoded: 'worker failure' } });
});

test('falls through to the server when a named worker action is missing', async () => {
	const fetch = vi.fn(() => Promise.resolve(new Response('server response')));
	const manifest = create_manifest();
	const { resolve } = instantiate_resolver(manifest, {
		fetch,
		workers: {
			'/src/routes/target/+page.worker.js': {
				actions: { local: () => ({ local: true }) }
			}
		}
	});
	const request = new Request('https://example.com/target?/server-only', {
		method: 'POST',
		headers: {
			'content-type': 'application/x-www-form-urlencoded',
			'x-sveltekit-action': 'true'
		},
		body: 'value=test'
	});

	const response = await resolve(request, { strategy: 'worker-first' });

	expect(fetch).toHaveBeenCalledOnce();
	expect(await response.text()).toBe('server response');
});

test('rejects the reserved named default worker action', async () => {
	const action = vi.fn(() => ({ local: true }));
	const manifest = create_manifest();
	const { resolve } = instantiate_resolver(manifest, {
		workers: {
			'/src/routes/target/+page.worker.js': {
				actions: { default: action }
			}
		}
	});
	const request = new Request('https://example.com/target?/default', {
		method: 'POST',
		headers: {
			'content-type': 'application/x-www-form-urlencoded',
			'x-sveltekit-action': 'true'
		},
		body: 'value=test'
	});

	const response = await resolve(request, { strategy: 'worker-first' });

	expect(response.status).toBe(500);
	expect(await response.json()).toEqual({
		type: 'error',
		error: { message: 'Cannot use reserved action name "default"' }
	});
	expect(action).not.toHaveBeenCalled();
});

test('rejects worker modules that mix default and named actions', async () => {
	const manifest = create_manifest();
	const { resolve } = instantiate_resolver(manifest, {
		workers: {
			'/src/routes/target/+page.worker.js': {
				actions: {
					default: () => ({ local: true }),
					named: () => ({ local: true })
				}
			}
		}
	});
	const request = new Request('https://example.com/target', {
		method: 'POST',
		headers: {
			'content-type': 'application/x-www-form-urlencoded',
			'x-sveltekit-action': 'true'
		},
		body: 'value=test'
	});

	const response = await resolve(request, { strategy: 'worker-first' });
	const result = await response.json();

	expect(response.status).toBe(500);
	expect(result.type).toBe('error');
	expect(result.error.message).toContain('default action cannot be used');
});

test('passes an already-aborted signal to server fetches as aborted', async () => {
	const controller = new AbortController();
	controller.abort();
	const fetch = vi.fn((_request, init) => {
		return Promise.resolve(new Response(String(init?.signal?.aborted)));
	});
	const manifest = create_manifest();
	const { resolve } = instantiate_resolver(manifest, {
		fetch,
		workers: {
			'/src/routes/target/+page.worker.js': {
				actions: {
					/** @param {{ server: (options: { signal: AbortSignal }) => Promise<Response> }} event */
					async default({ server }) {
						const response = await server({ signal: controller.signal });
						return { aborted: await response.text() };
					}
				}
			}
		}
	});
	const request = new Request('https://example.com/target', {
		method: 'POST',
		headers: {
			'content-type': 'application/x-www-form-urlencoded',
			'x-sveltekit-action': 'true'
		},
		body: 'value=test'
	});

	const response = await resolve(request, { strategy: 'worker-first' });

	expect(await read_action_data(response)).toMatchObject({
		type: 'success',
		data: { aborted: 'true' }
	});
});

test('treats timeout zero as an immediate server fetch timeout', async () => {
	vi.useFakeTimers();
	try {
		const fetch = vi.fn(async (_request, init) => {
			if (!init?.signal) return new Response('not aborted');

			return new Promise((resolve) => {
				init.signal.addEventListener('abort', () => resolve(new Response('aborted')), {
					once: true
				});
			});
		});
		const manifest = create_manifest();
		const { resolve } = instantiate_resolver(manifest, {
			fetch,
			workers: {
				'/src/routes/target/+page.worker.js': {
					actions: {
						/** @param {{ server: (options: { timeout: number }) => Promise<Response> }} event */
						async default({ server }) {
							const response = await server({ timeout: 0 });
							return { result: await response.text() };
						}
					}
				}
			}
		});
		const request = new Request('https://example.com/target', {
			method: 'POST',
			headers: {
				'content-type': 'application/x-www-form-urlencoded',
				'x-sveltekit-action': 'true'
			},
			body: 'value=test'
		});

		const response_promise = resolve(request, { strategy: 'worker-first' });
		await vi.runAllTimersAsync();
		const response = await response_promise;

		expect(await read_action_data(response)).toMatchObject({
			type: 'success',
			data: { result: 'aborted' }
		});
	} finally {
		vi.useRealTimers();
	}
});
