import { fileURLToPath } from 'node:url';
import { dedent } from '../../core/sync/utils.js';
import { posixify } from '../../utils/os.js';
import { s } from '../../utils/misc.js';

const DATA_SUFFIX = '/__data.json';
const HTML_DATA_SUFFIX = '.html__data.json';
const routing = posixify(fileURLToPath(new URL('../../utils/routing.js', import.meta.url)));
const url_utils = posixify(fileURLToPath(new URL('../../utils/url.js', import.meta.url)));

/**
 * @param {import('types').ManifestData} manifest_data
 * @param {{ base?: string; version?: string; version_check?: boolean }} [options]
 */
export function create_service_worker_resolver(manifest_data, options = {}) {
	// Routes without workers still take precedence over less specific worker routes.
	const has_workers = manifest_data.nodes.some((node) => node.worker);
	const routes = has_workers
		? manifest_data.routes.filter((route) => route.page || route.endpoint)
		: [];

	/** @type {string[]} */
	const imports = [];
	/** @type {Map<string, string>} */
	const worker_imports = new Map();

	if (routes.length > 0) {
		imports.push(`import { exec } from ${s(routing)};`);
		imports.push(`import { normalize_path } from ${s(url_utils)};`);
	}

	const hooks_name = manifest_data.hooks.universal && routes.length > 0 ? 'universal_hooks' : null;
	if (hooks_name) {
		imports.push(`import * as ${hooks_name} from ${s(`/${manifest_data.hooks.universal}`)};`);
	}

	const uses_matchers = routes.some((route) => route.params.some((param) => param.matcher));
	const matchers_name = uses_matchers ? 'worker_matchers' : null;
	if (matchers_name) {
		imports.push(`import { params as ${matchers_name} } from ${s(`/${manifest_data.params}`)};`);
	}

	const route_data = routes.map((route) => {
		const page = route.page;
		const nodes = (page ? [...page.layouts, page.leaf] : []).map((index) => {
			const node = index === undefined ? null : manifest_data.nodes[index];
			if (!node) return 'null';

			let worker = 'null';
			if (node.worker) {
				worker = worker_imports.get(node.worker) ?? `worker_${worker_imports.size}`;
				if (!worker_imports.has(node.worker)) {
					worker_imports.set(node.worker, worker);
					imports.push(`import * as ${worker} from ${s(`/${node.worker}`)};`);
				}
			}

			return dedent`
				{
					server: ${node.server ? 'true' : 'false'},
					slash: ${node.page_options?.trailingSlash ? s(node.page_options.trailingSlash) : 'null'},
					worker: ${worker}
				}
			`;
		});

		return dedent`
			{
				id: ${s(route.id)},
				pattern: ${route.pattern},
				params: ${s(route.params)},
				nodes: [${nodes.join(', ')}]
			}
		`;
	});

	const devalue_import = routes.length > 0 ? "import * as devalue from 'devalue';" : '';

	return dedent`
		${devalue_import}
		${imports.join('\n')}

		const DATA_SUFFIX = ${s(DATA_SUFFIX)};
		const HTML_DATA_SUFFIX = ${s(HTML_DATA_SUFFIX)};
		const base = ${s(options.base ?? '')};
		const version = ${s(options.version ?? '')};
		const version_check = ${options.version_check === false ? 'false' : 'true'};

		const worker_routes = [${route_data.join(',\n')}];
		const worker_hooks = ${hooks_name ?? 'null'};
		const route_matchers = ${matchers_name ?? '{}'};
		const transport_reducers = Object.fromEntries(
			Object.entries(worker_hooks?.transport ?? {}).map(([key, value]) => [key, value.encode])
		);

		export async function resolve(event, options = {}) {
			const request = event instanceof Request ? event : event.request;
			request.signal.throwIfAborted();
			const url = new URL(request.url);
			if (
				url.origin !== location.origin ||
				(base && url.pathname !== base && !url.pathname.startsWith(base + '/'))
			) {
				return fetch(request);
			}

			const strategy = options.strategy ?? 'network-first';

			if (strategy === 'worker-first') {
				const response = await resolve_worker_response(request);
				request.signal.throwIfAborted();
				if (response) return response;

				return fetch(request);
			}

			const fallback_request = request.method === 'POST' ? request.clone() : request;

			try {
				const response = await fetch(request);
				request.signal.throwIfAborted();
				return response;
			} catch (error) {
				request.signal.throwIfAborted();
				const response = await resolve_worker_response(fallback_request);
				request.signal.throwIfAborted();
				if (response) return response;
				throw error;
			}
		}

		async function resolve_worker_response(request) {
			if (is_action_json_request(request)) {
				return resolve_worker_action(request);
			}

			return resolve_worker_data(request);
		}

		async function resolve_worker_data(request) {
			if (request.method !== 'GET') return null;

			const request_url = new URL(request.url);
			const pathname = decode_pathname(strip_base(request_url.pathname));
			let page_pathname = remove_data_suffix(pathname);
			if (!page_pathname) return null;
			if (
				request_url.searchParams.get('x-sveltekit-trailing-slash') === '1' &&
				!page_pathname.endsWith('/')
			) {
				page_pathname += '/';
			}

			const page_url = new URL(request.url);
			page_url.pathname = add_base(page_pathname);
			page_url.searchParams.delete('x-sveltekit-invalidated');
			page_url.searchParams.delete('x-sveltekit-trailing-slash');

			const route_match = await match_worker_route(page_url);
			request.signal.throwIfAborted();
			if (!route_match) return null;

			const trailing_slash =
				page_url.pathname === base || page_url.pathname === base + '/'
					? 'always'
					: route_match.route.nodes.reduce((slash, node) => node?.slash ?? slash, 'never');
			page_url.pathname = normalize_path(page_url.pathname, trailing_slash);

			const invalidated = parse_invalidated(
				request_url.searchParams.get('x-sveltekit-invalidated'),
				route_match.route.nodes.length
			);

			const nodes = [];
			const throw_if_aborted = () => {
				if (!request.signal.aborted) return;
				try {
					// Observe deferred data from completed loads before discarding the response.
					render_data_response(nodes);
				} finally {
					request.signal.throwIfAborted();
				}
			};
			const parent_data = {};
			const should_load = get_required_workers(route_match.route.nodes, invalidated);
			let handled = false;

			for (let i = 0; i < route_match.route.nodes.length; i += 1) {
				throw_if_aborted();
				const node = route_match.route.nodes[i];

				if (!should_load[i]) {
					nodes[i] = { type: 'skip' };
					continue;
				}

				if (!node?.worker?.load) {
					if (invalidated[i] && node?.server) return null;
					nodes[i] = invalidated[i] ? null : { type: 'skip' };
					continue;
				}

				handled = true;
				const uses = create_uses();
				let data;
				try {
					data = await node.worker.load({
						request,
						url: make_trackable_url(page_url, uses),
						route: track_route({ id: route_match.route.id }, uses),
						params: track_params(route_match.params, uses),
						network: get_network_state(),
						parent: async () => {
							uses.parent = true;
							return { ...parent_data };
						},
						server: (options) => fetch_with_options(request, options)
					});
				} catch (error) {
					throw_if_aborted();
					if (is_redirect(error)) return redirect_response(error);

					nodes[i] = {
						type: 'error',
						error: serialize_error(error)
					};
					for (let j = i + 1; j < route_match.route.nodes.length; j += 1) {
						nodes[j] = { type: 'skip' };
					}

					return data_response(nodes);
				}

				if (!invalidated[i]) {
					nodes[i] = { type: 'skip' };
				} else {
					nodes[i] = {
						type: 'data',
						data,
						slash: node.slash,
						uses: serialize_uses(uses)
					};
				}

				if (data && typeof data === 'object') {
					Object.assign(parent_data, data);
				}
			}

			if (!handled) return null;

			return data_response(nodes);
		}

		async function resolve_worker_action(request) {
			const request_url = new URL(request.url);
			const page_url = new URL(request.url);
			const route_match = await match_worker_route(page_url);
			request.signal.throwIfAborted();
			if (!route_match) return null;

			const node = route_match.route.nodes[route_match.route.nodes.length - 1];
			const actions = node?.worker?.actions;
			if (!actions) return null;

			try {
				if (Object.hasOwn(actions, 'default') && actions.default && Object.keys(actions).length > 1) {
					throw new Error(
						'When using named actions, the default action cannot be used. See the docs for more info: https://svelte.dev/docs/kit/form-actions#named-actions'
					);
				}

				const action_name = get_action_name(request_url);
				if (!Object.hasOwn(actions, action_name)) return null;
				const action = actions[action_name];
				if (!action) return null;

				if (!is_form_content_type(request)) {
					return action_response({
						type: 'error',
						status: 415,
						error: {
							status: 415,
							message: \`Form actions expect form-encoded data — received \${request.headers.get(
								'content-type'
							)}\`
						}
					});
				}

				const server_request = request.clone();
				return action_response(
					await action({
						request,
						url: page_url,
						route: { id: route_match.route.id },
						params: route_match.params,
						network: get_network_state(),
						action: action_name,
						server: (options) => fetch_with_options(server_request.clone(), options)
					})
				);
			} catch (error) {
				request.signal.throwIfAborted();
				return action_response(normalize_action_error(error));
			}
		}

		function get_required_workers(nodes, invalidated) {
			const required = Array.from({ length: nodes.length }, (_, i) => invalidated[i]);
			let descendant_worker_required = false;

			for (let i = nodes.length - 1; i >= 0; i -= 1) {
				const node = nodes[i];
				if (node?.worker && descendant_worker_required) {
					required[i] = true;
				}

				if (node?.worker && required[i]) {
					descendant_worker_required = true;
				}
			}

			return required;
		}

		function is_action_json_request(request) {
			const accept = request.headers.get('accept') ?? '*/*';
			return (
				request.method === 'POST' &&
				request.headers.get('x-sveltekit-action') === 'true' &&
				(accept.includes('application/json') || accept.includes('*/*'))
			);
		}

		function get_action_name(url) {
			let name = 'default';

			for (const param of url.searchParams) {
				if (param[0].startsWith('/')) {
					name = param[0].slice(1);
					if (name === 'default') {
						throw new Error('Cannot use reserved action name "default"');
					}
					break;
				}
			}

			return name;
		}

		async function match_worker_route(page_url) {
			let rerouted = page_url;
			if (worker_hooks?.reroute) {
				rerouted =
					(await worker_hooks.reroute({
						url: new URL(page_url),
						fetch: (input, init) =>
							fetch(input instanceof Request ? input : new URL(input, page_url), init)
					})) ?? page_url;

				if (typeof rerouted === 'string') {
					const url = new URL(page_url);
					url.pathname = rerouted;
					rerouted = url;
				}
			}

			return find_worker_route(decode_pathname(strip_base(rerouted.pathname)));
		}

		function is_form_content_type(request) {
			const type = request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
			return (
				type === 'application/x-www-form-urlencoded' ||
				type === 'multipart/form-data' ||
				type === 'text/plain'
			);
		}

		function find_worker_route(pathname) {
			for (const route of worker_routes) {
				const match = route.pattern.exec(pathname);
				if (!match) continue;
				const params = exec(match, route.params, route_matchers);
				if (!params) continue;

				return { route, params };
			}
		}

		function decode_pathname(pathname) {
			return pathname.split('%25').map(decodeURI).join('%25');
		}

		function create_uses() {
			return {
				params: new Set(),
				parent: false,
				route: false,
				url: false,
				search_params: new Set()
			};
		}

		function serialize_uses(uses) {
			const result = {};

			if (uses.params.size > 0) result.params = Array.from(uses.params);
			if (uses.search_params.size > 0) {
				result.search_params = Array.from(uses.search_params);
			}

			if (uses.parent) result.parent = 1;
			if (uses.route) result.route = 1;
			if (uses.url) result.url = 1;

			return result;
		}

		function track_params(params, uses) {
			return new Proxy(params, {
				get(target, key) {
					if (typeof key === 'string') uses.params.add(key);
					return target[key];
				}
			});
		}

		function track_route(route, uses) {
			return new Proxy(route, {
				get(target, key) {
					if (typeof key === 'string') uses.route = true;
					return target[key];
				}
			});
		}

		function make_trackable_url(url, uses) {
			const tracked = new URL(url);

			Object.defineProperty(tracked, 'searchParams', {
				value: new Proxy(tracked.searchParams, {
					get(target, key) {
						if (key === 'get' || key === 'getAll' || key === 'has') {
							return (param, ...rest) => {
								uses.search_params.add(param);
								return target[key](param, ...rest);
							};
						}

						uses.url = true;
						const value = Reflect.get(target, key);
						return typeof value === 'function' ? value.bind(target) : value;
					}
				}),
				enumerable: true,
				configurable: true
			});

			for (const property of ['href', 'pathname', 'search', 'toString', 'toJSON']) {
				Object.defineProperty(tracked, property, {
					get() {
						uses.url = true;
						const value = url[property];
						return typeof value === 'function' ? value.bind(url) : value;
					},
					enumerable: true,
					configurable: true
				});
			}

			return tracked;
		}

		function data_response(nodes) {
			const { data, chunks } = render_data_response(nodes);

			if (!chunks) {
				return response(data, {
					'content-type': 'application/json'
				});
			}

			const encoder = new TextEncoder();

			return response(
				new ReadableStream({
					async start(controller) {
						controller.enqueue(encoder.encode(data));

						for await (const chunk of chunks) {
							controller.enqueue(encoder.encode(chunk));
						}

						controller.close();
					},
					type: 'bytes'
				}),
				{
					'content-type': 'text/sveltekit-data'
				}
			);
		}

		function redirect_response(redirect) {
			return response(
				JSON.stringify({
					type: 'redirect',
					status: redirect.status,
					location: String(redirect.location)
				}) + '\\n',
				{
					'content-type': 'application/json'
				}
			);
		}

		function render_data_response(nodes) {
			let promise_id = 1;
			const iterator = create_async_iterator();

			const reducers = {
				...transport_reducers,
				Promise: (thing) => {
					if (typeof thing?.then !== 'function') return;

					const id = promise_id++;
					let key = 'data';

					const promise = thing
						.catch((error) => {
							key = 'error';
							return serialize_error(error);
						})
						.then((value) => {
							let str;

							try {
								str = devalue.stringify(value, reducers);
							} catch {
								key = 'error';
								str = devalue.stringify(
									serialize_error(
										new Error('Failed to serialize promise while rendering worker data')
									),
									reducers
								);
							}

							return \`{"type":"chunk","id":\${id},"\${key}":\${str}}\\n\`;
						});

					iterator.add(promise);

					return id;
				}
			};

			const data =
				'{"type":"data","nodes":[' +
				nodes
					.map((node) => {
						if (!node || node.type === 'skip' || node.type === 'error') {
							return JSON.stringify(node);
						}
						return (
							'{"type":"data","data":' +
							devalue.stringify(node.data, reducers) +
							',"uses":' +
							JSON.stringify(node.uses) +
							(node.slash ? ',"slash":' + JSON.stringify(node.slash) : '') +
							'}'
						);
					})
					.join(',') +
				']}\\n';

			return {
				data,
				chunks: promise_id > 1 ? iterator.iterate() : null
			};
		}

		function create_async_iterator() {
			let resolved = -1;
			let returned = -1;
			const deferred = [];

			return {
				iterate: () => {
					return {
						[Symbol.asyncIterator]() {
							return {
								next: async () => {
									const next = deferred[++returned];
									if (!next) return { value: null, done: true };

									return { value: await next.promise, done: false };
								}
							};
						}
					};
				},
				add: (promise) => {
					deferred.push(with_resolvers());
					void promise.then((value) => {
						deferred[++resolved].resolve(value);
					});
				}
			};
		}

		function with_resolvers() {
			let resolve;
			const promise = new Promise((fulfil) => {
				resolve = fulfil;
			});

			return { promise, resolve };
		}

		function action_response(result) {
			const normalized = normalize_action_result(result);
			const headers = response_headers('application/json');

			if (normalized.type === 'success' && normalized.status === 204) {
				return new Response(null, { status: 204, headers });
			}

			const body = serialize_action_result(normalized);
			const status =
				normalized.type === 'error' || normalized.type === 'failure' ? normalized.status : 200;

			return new Response(body + '\\n', { status, headers });
		}

		function normalize_action_result(result) {
			if (is_action_result(result)) {
				if (result.type === 'error') {
					const error = serialize_error(result.error);
					return {
						type: 'error',
						status: is_error_status(result.status) ? result.status : error.status,
						error
					};
				}

				return result;
			}

			if (is_action_failure(result)) {
				return {
					type: 'failure',
					status: result.status,
					data: result.data
				};
			}

			return result
				? {
						type: 'success',
						status: 200,
						data: result
					}
				: {
						type: 'success',
						status: 204
					};
		}

		function normalize_action_error(error) {
			if (is_redirect(error)) {
				return {
					type: 'redirect',
					status: error.status,
					location: String(error.location)
				};
			}

			const serialized = serialize_error(error);
			return {
				type: 'error',
				status: serialized.status,
				error: serialized
			};
		}

		function serialize_action_result(result) {
			if (result.type === 'success' || result.type === 'failure') {
				return JSON.stringify({
					type: result.type,
					status: result.status,
					data: devalue.stringify(result.data, transport_reducers)
				});
			}

			if (result.type === 'redirect') {
				return JSON.stringify({
					type: 'redirect',
					status: result.status,
					location: String(result.location)
				});
			}

			return JSON.stringify({
				type: 'error',
				error: serialize_error(result.error)
			});
		}

		function is_action_result(result) {
			if (!result || typeof result !== 'object') return false;

			if (result.type === 'success') {
				return typeof result.status === 'number' && result.status >= 200 && result.status <= 299;
			}

			if (result.type === 'failure') {
				return is_error_status(result.status);
			}

			if (result.type === 'redirect') {
				return (
					typeof result.status === 'number' &&
					result.status >= 300 &&
					result.status <= 308 &&
					typeof result.location === 'string'
				);
			}

			if (result.type === 'error') {
				return 'error' in result && (result.status === undefined || is_error_status(result.status));
			}

			return false;
		}

		function is_action_failure(result) {
			return (
				result &&
				typeof result === 'object' &&
				!('type' in result) &&
				is_error_status(result.status) &&
				'data' in result
			);
		}

		function is_redirect(error) {
			return (
				error &&
				typeof error === 'object' &&
				error.status >= 300 &&
				error.status <= 308 &&
				'location' in error
			);
		}

		function is_error_status(status) {
			return typeof status === 'number' && status >= 400 && status <= 599;
		}

		function serialize_error(error) {
			const status = is_error_status(error?.status) ? error.status : 500;

			if (error && typeof error === 'object' && 'body' in error) {
				return {
					message: 'Unknown Error',
					...error.body,
					status
				};
			}

			if (error && typeof error === 'object' && typeof error.message === 'string') {
				return {
					...error,
					status,
					message: error.message
				};
			}

			return { status, message: 'Internal Error' };
		}

		function parse_invalidated(value, length) {
			if (!value) return Array.from({ length }, () => true);
			return Array.from({ length }, (_, i) => value[i] === '1');
		}

		function get_network_state() {
			if (typeof navigator === 'undefined' || typeof navigator.onLine !== 'boolean') {
				return { status: 'unknown' };
			}

			return { status: navigator.onLine ? 'online' : 'offline' };
		}

		function fetch_with_options(request, options = {}) {
			const has_timeout = options.timeout !== undefined;
			if (!has_timeout && !options.signal) return fetch(request);

			const controller = new AbortController();
			const timeout = has_timeout ? setTimeout(() => controller.abort(), options.timeout) : null;
			// Preserve both request and caller cancellation while consuming the raw response body.
			const signal = AbortSignal.any(
				[request.signal, options.signal, controller.signal].filter((signal) => signal !== undefined)
			);

			return fetch(request, { signal }).finally(() => {
				if (timeout !== null) clearTimeout(timeout);
			});
		}

		function response(body, headers) {
			return new Response(body, { headers: response_headers(headers['content-type']) });
		}

		function response_headers(content_type) {
			const headers = new Headers({
				'content-type': content_type,
				'cache-control': 'private, no-store',
				'x-sveltekit-worker': '1'
			});

			if (version_check) {
				headers.set('x-sveltekit-version', version);
			}

			return headers;
		}

		function strip_base(pathname) {
			if (!base) return pathname;
			if (pathname === base) return '/';
			if (pathname.startsWith(base + '/')) return pathname.slice(base.length);
			return pathname;
		}

		function add_base(pathname) {
			return base + (pathname === '/' ? '' : pathname);
		}

		function remove_data_suffix(pathname) {
			if (pathname.endsWith(DATA_SUFFIX)) {
				return pathname.slice(0, -DATA_SUFFIX.length) || '/';
			}

			if (pathname.endsWith(HTML_DATA_SUFFIX)) {
				return pathname.slice(0, -HTML_DATA_SUFFIX.length) + '.html';
			}
		}
	`;
}
