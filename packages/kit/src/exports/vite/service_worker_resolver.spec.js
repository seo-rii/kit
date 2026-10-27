import { execFileSync } from 'node:child_process';
import { execPath } from 'node:process';
import * as devalue from 'devalue';
import { expect, test, vi } from 'vitest';
import { exec } from '../../utils/routing.js';
import { create_service_worker_resolver } from './service_worker_resolver.js';

/**
 * @param {{
 *   hooks?: import('types').ManifestData['hooks'];
 *   route_id?: string;
 *   pattern?: RegExp;
 *   params?: import('types').RouteParam[];
 *   params_file?: string | null;
 *   trailing_slash?: import('types').TrailingSlash;
 *   worker_file?: string;
 * }} options
 * @returns {import('types').ManifestData}
 */
function create_manifest({
	hooks = { client: null, server: null, universal: null },
	route_id = '/target',
	pattern = /^\/target\/?$/,
	params = [],
	params_file = null,
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
		nodes: [node],
		params: params_file,
		routes: [
			{
				id: route_id,
				parent: null,
				segment: route_id.slice(1),
				pattern,
				params,
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
 *   base?: string;
 *   fetch?: typeof fetch;
 *   hooks?: Record<string, any>;
 *   matchers?: Record<string, import('@sveltejs/kit').ParamMatcher>;
 *   workers: Record<string, Record<string, any>>;
 * }} options
 */
function instantiate_resolver(
	manifest,
	{ base = '', fetch = globalThis.fetch, hooks = {}, matchers = {}, workers }
) {
	const source = create_service_worker_resolver(manifest, {
		base,
		version: 'test-version'
	})
		.replace("import * as devalue from 'devalue';", '')
		.replace(/^import \{ exec \} from "[^"]+";$/m, '')
		.replace(
			/^import \* as (worker_\d+) from ("[^"]+");$/gm,
			(_, name, file) => `const ${name} = workers[${file}];`
		)
		.replace(/^import \* as universal_hooks from "[^"]+";$/m, '')
		.replace(/^import \{ params as worker_matchers \} from "[^"]+";$/m, '')
		.replace('export async function resolve', 'async function resolve');

	const factory = new Function(
		'devalue',
		'exec',
		'workers',
		'universal_hooks',
		'worker_matchers',
		'fetch',
		'location',
		`${source}\nreturn { resolve };`
	);

	return factory(
		devalue,
		exec,
		workers,
		hooks,
		matchers,
		fetch,
		new URL('https://example.com/service-worker.js')
	);
}

/** @param {Response} response */
async function read_action_data(response) {
	if (response.status === 204) return null;

	const result = await response.json();
	if (result.type === 'success' || result.type === 'failure') {
		result.data = devalue.parse(result.data);
	}
	return result;
}

/**
 * @param {string} method
 * @param {{ url?: string; signal?: AbortSignal }} options
 */
function create_worker_request(method, { url = 'https://example.com/target', signal } = {}) {
	return new Request(method === 'GET' ? `${url}/__data.json` : url, {
		method,
		signal,
		...(method === 'POST'
			? {
					headers: {
						accept: 'application/json',
						'content-type': 'application/x-www-form-urlencoded',
						'x-sveltekit-action': 'true'
					},
					body: 'value=test'
				}
			: {})
	});
}

for (const strategy of ['worker-first', 'network-first']) {
	test.each(['GET', 'POST'])(
		`rejects an already aborted %s request without invoking workers (${strategy})`,
		async (method) => {
			const controller = new AbortController();
			const reason = new Error('request canceled');
			controller.abort(reason);
			const fetch = vi.fn(() => Promise.reject(new TypeError('offline')));
			const handler = vi.fn(() => ({ local: true }));
			const { resolve } = instantiate_resolver(create_manifest(), {
				fetch,
				workers: {
					'/src/routes/target/+page.worker.js': {
						load: handler,
						actions: { default: handler }
					}
				}
			});

			await expect(
				resolve(create_worker_request(method, { signal: controller.signal }), { strategy })
			).rejects.toBe(reason);
			expect(handler).not.toHaveBeenCalled();
			expect(fetch).not.toHaveBeenCalled();
		}
	);

	test.each(['GET', 'POST'])(
		`rejects a %s request canceled during rerouting before invoking workers (${strategy})`,
		async (method) => {
			const controller = new AbortController();
			const reason = new Error('request canceled during rerouting');
			const handler = vi.fn(() => ({ local: true }));
			const { resolve } = instantiate_resolver(
				create_manifest({ hooks: { client: null, server: null, universal: 'src/hooks.js' } }),
				{
					fetch: vi.fn(() => Promise.reject(new TypeError('offline'))),
					hooks: {
						async reroute() {
							await Promise.resolve();
							controller.abort(reason);
							return '/target';
						}
					},
					workers: {
						'/src/routes/target/+page.worker.js': {
							load: handler,
							actions: { default: handler }
						}
					}
				}
			);

			await expect(
				resolve(create_worker_request(method, { signal: controller.signal }), { strategy })
			).rejects.toBe(reason);
			expect(handler).not.toHaveBeenCalled();
		}
	);
}

test.each(['GET', 'POST'])(
	'does not treat cancellation of the initial %s fetch as a network failure',
	async (method) => {
		const controller = new AbortController();
		const reason = new Error('fetch canceled');
		const fetch = vi.fn(() => {
			controller.abort(reason);
			return Promise.reject(reason);
		});
		const handler = vi.fn(() => ({ local: true }));
		const { resolve } = instantiate_resolver(create_manifest(), {
			fetch,
			workers: {
				'/src/routes/target/+page.worker.js': {
					load: handler,
					actions: { default: handler }
				}
			}
		});

		await expect(
			resolve(create_worker_request(method, { signal: controller.signal }))
		).rejects.toBe(reason);
		expect(fetch).toHaveBeenCalledOnce();
		expect(handler).not.toHaveBeenCalled();
	}
);

for (const throws of [false, true]) {
	test.each(['GET', 'POST'])(
		`preserves %s cancellation when the worker ${throws ? 'throws' : 'returns'}`,
		async (method) => {
			const controller = new AbortController();
			const reason = new Error('request canceled during worker execution');
			const handler = vi.fn(() => {
				controller.abort(reason);
				if (throws) throw reason;
				return { local: true };
			});
			const fetch = vi.fn(() => Promise.reject(new TypeError('offline')));
			const { resolve } = instantiate_resolver(create_manifest(), {
				fetch,
				workers: {
					'/src/routes/target/+page.worker.js': {
						load: handler,
						actions: { default: handler }
					}
				}
			});

			await expect(
				resolve(create_worker_request(method, { signal: controller.signal }), {
					strategy: 'worker-first'
				})
			).rejects.toBe(reason);
			expect(handler).toHaveBeenCalledOnce();
			expect(fetch).not.toHaveBeenCalled();
		}
	);
}

test.each(['layout', 'page'])(
	'observes completed layout promises when the request is canceled in the %s load',
	(stage) => {
		const manifest = create_manifest();
		manifest.nodes.unshift({
			depth: 0,
			server: 'src/routes/+layout.server.js',
			worker: 'src/routes/+layout.worker.js'
		});
		manifest.routes[0].page = { layouts: [0], errors: [], leaf: 1 };
		const source = create_service_worker_resolver(manifest).replace(
			/^import \* as (worker_\d+) from ("[^"]+");$/gm,
			(_, name, file) => `const ${name} = workers[${file}];`
		);

		execFileSync(
			execPath,
			[
				'--unhandled-rejections=strict',
				'--input-type=module',
				'-e',
				`
					import assert from 'node:assert/strict';
					const location = new URL('https://example.com/service-worker.js');
					const controller = new AbortController();
					const reason = new Error('request canceled');
					const stage = ${JSON.stringify(stage)};
					let page_calls = 0;
					const workers = {
						'/src/routes/+layout.worker.js': {
							load() {
								if (stage === 'layout') controller.abort(reason);
								return { later: Promise.reject(new Error('discarded layout promise')) };
							}
						},
						'/src/routes/target/+page.worker.js': {
							load() {
								page_calls += 1;
								controller.abort(reason);
								throw reason;
							}
						}
					};
					${source}
					await assert.rejects(
						resolve(new Request('https://example.com/target/__data.json', {
							signal: controller.signal
						}), { strategy: 'worker-first' }),
						(error) => error === reason
					);
					assert.equal(page_calls, stage === 'layout' ? 0 : 1);
					await new Promise(setImmediate);
				`
			],
			{ stdio: 'pipe' }
		);
	}
);

for (const strategy of ['worker-first', 'network-first']) {
	for (const method of ['GET', 'POST']) {
		test.each([
			'https://other.example/app/target',
			'http://example.com/app/target',
			'https://example.com:444/app/target',
			'https://example.com/target',
			'https://example.com/application/target'
		])(`passes ${method} %s outside the app to fetch (${strategy})`, async (url) => {
			const error = new TypeError('network failure');
			const network_response = new Response('network response');
			const fetch = vi.fn(() =>
				strategy === 'network-first' ? Promise.reject(error) : Promise.resolve(network_response)
			);
			const handler = vi.fn(() => ({ local: true }));
			const reroute = vi.fn(() => '/app/target');
			const { resolve } = instantiate_resolver(
				create_manifest({ hooks: { client: null, server: null, universal: 'src/hooks.js' } }),
				{
					base: '/app',
					fetch,
					hooks: { reroute },
					workers: {
						'/src/routes/target/+page.worker.js': {
							load: handler,
							actions: { default: handler }
						}
					}
				}
			);
			const request = create_worker_request(method, { url });

			if (strategy === 'network-first') {
				await expect(resolve(request, { strategy })).rejects.toBe(error);
			} else {
				expect(await resolve(request, { strategy })).toBe(network_response);
			}
			expect(fetch).toHaveBeenCalledExactlyOnceWith(request);
			expect(reroute).not.toHaveBeenCalled();
			expect(handler).not.toHaveBeenCalled();
		});

		test.each([
			{ pathname: '/app/target', route_id: '/target', pattern: /^\/target\/?$/ },
			{ pathname: '/app', route_id: '/', pattern: /^\/$/ }
		])(`resolves ${method} $pathname inside the app (${strategy})`, async (route) => {
			const fetch = vi.fn(() => Promise.reject(new TypeError('offline')));
			const handler = vi.fn((/** @type {{ url: URL }} */ { url }) => ({
				pathname: url.pathname
			}));
			const { resolve } = instantiate_resolver(create_manifest(route), {
				base: '/app',
				fetch,
				workers: {
					'/src/routes/target/+page.worker.js': {
						load: handler,
						actions: { default: handler }
					}
				}
			});

			const response = await resolve(
				create_worker_request(method, { url: `https://example.com${route.pathname}` }),
				{ strategy }
			);
			const body = await response.json();
			const data =
				method === 'GET' ? devalue.unflatten(body.nodes[0].data) : devalue.parse(body.data);

			expect(data).toEqual({ pathname: route.pathname });
			expect(handler).toHaveBeenCalledOnce();
			expect(fetch).toHaveBeenCalledTimes(strategy === 'network-first' ? 1 : 0);
		});
	}
}

test('only imports the params module when a worker route uses a matcher', () => {
	const manifest = create_manifest();
	const worker_route = manifest.routes[0];
	worker_route.id = '/worker/[id=used]';
	worker_route.pattern = /^\/worker\/([^/]+?)\/?$/;
	worker_route.params = [
		{
			name: 'id',
			matcher: 'used',
			optional: false,
			rest: false,
			chained: false
		}
	];
	manifest.params = 'src/params.js';

	const code = create_service_worker_resolver(manifest);
	expect(code).toContain('import { params as worker_matchers } from "/src/params.js";');

	worker_route.params = [];
	expect(create_service_worker_resolver(manifest)).not.toContain('/src/params.js');
});

test('uses Standard Schema matcher output for worker params', async () => {
	const manifest = create_manifest({
		route_id: '/target/[id=integer]',
		pattern: /^\/target\/([^/]+?)\/?$/,
		params: [
			{
				name: 'id',
				matcher: 'integer',
				optional: false,
				rest: false,
				chained: false
			}
		],
		params_file: 'src/params.js'
	});
	const { resolve } = instantiate_resolver(manifest, {
		matchers: {
			integer: {
				'~standard': {
					version: 1,
					vendor: 'test',
					validate: (value) => ({ value: Number(value) })
				}
			}
		},
		workers: {
			'/src/routes/target/+page.worker.js': {
				/** @param {{ params: Record<string, string | number> }} event */
				load: ({ params }) => ({ value: params.id, type: typeof params.id })
			}
		}
	});

	const response = await resolve(new Request('https://example.com/target/42/__data.json'), {
		strategy: 'worker-first'
	});
	const body = await response.json();

	expect(devalue.unflatten(body.nodes[0].data)).toEqual({ value: 42, type: 'number' });
});

test('serializes worker load errors with status inside the error object', async () => {
	const manifest = create_manifest();
	const { resolve } = instantiate_resolver(manifest, {
		workers: {
			'/src/routes/target/+page.worker.js': {
				load() {
					throw { status: 404, body: { message: 'worker not found', status: 404 } };
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
				error: { message: 'worker not found', status: 404 }
			}
		]
	});
});

test('serializes worker load redirects with their status', async () => {
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

	expect(await response.json()).toEqual({ type: 'redirect', status: 303, location: '/login' });
});

test('adds the deployment version to worker data responses', async () => {
	const manifest = create_manifest();
	const { resolve } = instantiate_resolver(manifest, {
		workers: {
			'/src/routes/target/+page.worker.js': {
				load: () => ({ local: true })
			}
		}
	});

	const response = await resolve(new Request('https://example.com/target/__data.json'), {
		strategy: 'worker-first'
	});

	expect(response.headers.get('x-sveltekit-version')).toBe('test-version');
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
			accept: 'application/json',
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
			accept: 'application/json',
			'content-type': 'application/x-www-form-urlencoded',
			'x-sveltekit-action': 'true'
		},
		body: 'value=test'
	});

	const response = await resolve(request, { strategy: 'worker-first' });
	const result = await response.json();

	expect(response.status).toBe(422);
	expect(result.type).toBe('failure');
	expect(result.status).toBe(422);
	expect(
		devalue.parse(result.data, {
			Custom: (value) => ({ decoded: value })
		})
	).toEqual({ custom: { decoded: 'worker failure' } });
});

test('uses the failure status as the worker action HTTP status', async () => {
	const manifest = create_manifest();
	const { resolve } = instantiate_resolver(manifest, {
		workers: {
			'/src/routes/target/+page.worker.js': {
				actions: {
					default: () => ({
						type: 'failure',
						status: 422,
						data: { invalid: true }
					})
				}
			}
		}
	});
	const request = new Request('https://example.com/target', {
		method: 'POST',
		headers: {
			accept: 'application/json',
			'content-type': 'application/x-www-form-urlencoded',
			'x-sveltekit-action': 'true'
		},
		body: 'value=test'
	});

	const response = await resolve(request, { strategy: 'worker-first' });

	expect(response.status).toBe(422);
	expect(await read_action_data(response)).toEqual({
		type: 'failure',
		status: 422,
		data: { invalid: true }
	});
});

test('returns a bodyless 204 when a worker action returns no data', async () => {
	const manifest = create_manifest();
	const { resolve } = instantiate_resolver(manifest, {
		workers: {
			'/src/routes/target/+page.worker.js': {
				actions: {
					default: () => undefined
				}
			}
		}
	});
	const request = new Request('https://example.com/target', {
		method: 'POST',
		headers: {
			accept: 'application/json',
			'content-type': 'application/x-www-form-urlencoded',
			'x-sveltekit-action': 'true'
		},
		body: 'value=test'
	});

	const response = await resolve(request, { strategy: 'worker-first' });

	expect(response.status).toBe(204);
	expect(await response.text()).toBe('');
	expect(response.headers.get('x-sveltekit-version')).toBe('test-version');
});

test('uses the error status as the worker action HTTP status', async () => {
	const manifest = create_manifest();
	const { resolve } = instantiate_resolver(manifest, {
		workers: {
			'/src/routes/target/+page.worker.js': {
				actions: {
					default() {
						throw { status: 403, body: { status: 403, message: 'Forbidden' } };
					}
				}
			}
		}
	});
	const request = new Request('https://example.com/target', {
		method: 'POST',
		headers: {
			accept: 'application/json',
			'content-type': 'application/x-www-form-urlencoded',
			'x-sveltekit-action': 'true'
		},
		body: 'value=test'
	});

	const response = await resolve(request, { strategy: 'worker-first' });

	expect(response.status).toBe(403);
	expect(await response.json()).toEqual({
		type: 'error',
		error: { status: 403, message: 'Forbidden' }
	});
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
			accept: 'application/json',
			'content-type': 'application/x-www-form-urlencoded',
			'x-sveltekit-action': 'true'
		},
		body: 'value=test'
	});

	const response = await resolve(request, { strategy: 'worker-first' });

	expect(fetch).toHaveBeenCalledOnce();
	expect(await response.text()).toBe('server response');
});

for (const strategy of ['worker-first', 'network-first']) {
	test.each(['toString', 'constructor', '__proto__', 'inherited'])(
		`treats inherited action %s as missing (${strategy})`,
		async (name) => {
			const error = new TypeError('offline');
			const network_response = new Response('server response');
			const fetch = vi.fn(() =>
				strategy === 'network-first' ? Promise.reject(error) : Promise.resolve(network_response)
			);
			const action = vi.fn(() => ({ local: true }));
			const { resolve } = instantiate_resolver(create_manifest(), {
				fetch,
				workers: {
					'/src/routes/target/+page.worker.js': {
						actions: Object.assign(Object.create({ inherited: action }), { local: action })
					}
				}
			});
			const request = create_worker_request('POST', {
				url: `https://example.com/target?/${name}`
			});

			if (strategy === 'network-first') {
				await expect(resolve(request, { strategy })).rejects.toBe(error);
			} else {
				expect(await resolve(request, { strategy })).toBe(network_response);
			}
			expect(fetch).toHaveBeenCalledExactlyOnceWith(request);
			expect(action).not.toHaveBeenCalled();
		}
	);
}

test.each(['toString', 'constructor', '__proto__'])(
	'invokes an explicitly registered %s action on a null-prototype actions object',
	async (name) => {
		const action = vi.fn(() => ({ local: true }));
		const { resolve } = instantiate_resolver(create_manifest(), {
			workers: {
				'/src/routes/target/+page.worker.js': {
					actions: Object.assign(Object.create(null), { [name]: action })
				}
			}
		});

		const response = await resolve(
			create_worker_request('POST', { url: `https://example.com/target?/${name}` }),
			{ strategy: 'worker-first' }
		);

		expect(await read_action_data(response)).toEqual({
			type: 'success',
			status: 200,
			data: { local: true }
		});
		expect(action).toHaveBeenCalledOnce();
	}
);

test('does not invoke an inherited default action', async () => {
	const network_response = new Response('server response');
	const fetch = vi.fn(() => Promise.resolve(network_response));
	const action = vi.fn(() => ({ local: true }));
	const { resolve } = instantiate_resolver(create_manifest(), {
		fetch,
		workers: {
			'/src/routes/target/+page.worker.js': {
				actions: Object.assign(Object.create({ default: action }), { local: action })
			}
		}
	});

	expect(await resolve(create_worker_request('POST'), { strategy: 'worker-first' })).toBe(
		network_response
	);
	expect(fetch).toHaveBeenCalledOnce();
	expect(action).not.toHaveBeenCalled();
});

test('does not count an inherited default action as a conflicting registered action', async () => {
	const inherited = vi.fn(() => ({ inherited: true }));
	const action = vi.fn(() => ({ local: true }));
	const { resolve } = instantiate_resolver(create_manifest(), {
		workers: {
			'/src/routes/target/+page.worker.js': {
				actions: Object.assign(Object.create({ default: inherited }), {
					local: action,
					other: action
				})
			}
		}
	});

	const response = await resolve(
		create_worker_request('POST', { url: 'https://example.com/target?/local' }),
		{ strategy: 'worker-first' }
	);

	expect(await read_action_data(response)).toMatchObject({
		type: 'success',
		data: { local: true }
	});
	expect(action).toHaveBeenCalledOnce();
	expect(inherited).not.toHaveBeenCalled();
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
			accept: 'application/json',
			'content-type': 'application/x-www-form-urlencoded',
			'x-sveltekit-action': 'true'
		},
		body: 'value=test'
	});

	const response = await resolve(request, { strategy: 'worker-first' });

	expect(response.status).toBe(500);
	expect(await response.json()).toEqual({
		type: 'error',
		error: { status: 500, message: 'Cannot use reserved action name "default"' }
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
			accept: 'application/json',
			'content-type': 'application/x-www-form-urlencoded',
			'x-sveltekit-action': 'true'
		},
		body: 'value=test'
	});

	const response = await resolve(request, { strategy: 'worker-first' });
	const result = await response.json();

	expect(response.status).toBe(500);
	expect(result.type).toBe('error');
	expect(result.error.status).toBe(500);
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
			accept: 'application/json',
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
				accept: 'application/json',
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
