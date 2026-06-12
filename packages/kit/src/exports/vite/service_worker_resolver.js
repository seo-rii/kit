import { s } from '../../utils/misc.js';
import { dedent } from '../../core/sync/utils.js';

const DATA_SUFFIX = '/__data.json';
const HTML_DATA_SUFFIX = '.html__data.json';

/**
 * @param {import('types').ManifestData} manifest_data
 */
export function create_service_worker_resolver(manifest_data) {
	const routes = manifest_data.routes.filter((route) => {
		if (!route.page) return false;

		return [...route.page.layouts, route.page.leaf].some((i) => {
			const node = i === undefined ? null : manifest_data.nodes[i];
			return node?.worker;
		});
	});
	/** @type {string[]} */
	const imports = [];
	/** @type {Map<string, string>} */
	const worker_imports = new Map();
	/** @type {Map<string, string>} */
	const matcher_imports = new Map();

	for (const [key, file] of Object.entries(manifest_data.matchers)) {
		const name = `matcher_${matcher_imports.size}`;
		matcher_imports.set(key, name);
		imports.push(`import { match as ${name} } from ${s(`/${file}`)};`);
	}

	const route_data = routes.map((route) => {
		const page = /** @type {NonNullable<import('types').RouteData['page']>} */ (route.page);
		const nodes = [...page.layouts, page.leaf].map((index) => {
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
					worker: ${worker}
				}
			`;
		});

		return dedent`
			{
				id: ${s(route.id)},
				pattern: ${route.pattern},
				params: [${route.params
					.map(
						(param) =>
							dedent`
							{
								name: ${s(param.name)},
								matcher: ${param.matcher ? (matcher_imports.get(param.matcher) ?? 'null') : 'null'},
								optional: ${param.optional ? 'true' : 'false'},
								rest: ${param.rest ? 'true' : 'false'},
								chained: ${param.chained ? 'true' : 'false'}
							}
						`
					)
					.join(', ')}],
				nodes: [${nodes.join(', ')}]
			}
		`;
	});

	const devalue_import = routes.length > 0 ? "import * as devalue from 'devalue';" : '';
	const worker_routes = `const worker_routes = [${route_data.join(',\n')}];`;

	return dedent`
		${devalue_import}
		${imports.join('\n')}

		const DATA_SUFFIX = ${s(DATA_SUFFIX)};
		const HTML_DATA_SUFFIX = ${s(HTML_DATA_SUFFIX)};

		${worker_routes}

		export async function resolve(event, options = {}) {
			const request = event instanceof Request ? event : event.request;
			const strategy = options.strategy ?? 'network-first';

			if (strategy === 'worker-first') {
				const response = await resolve_worker_response(request);
				if (response) return response;

				return fetch(request);
			}

			const fallback_request = request.method === 'POST' ? request.clone() : request;

			try {
				return await fetch(request);
			} catch (error) {
				const response = await resolve_worker_response(fallback_request);
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
			if (request_url.searchParams.get('x-sveltekit-trailing-slash') === '1' && !page_pathname.endsWith('/')) {
				page_pathname += '/';
			}

			const route_match = find_worker_route(page_pathname);
			if (!route_match) return null;

			const invalidated = parse_invalidated(request_url.searchParams.get('x-sveltekit-invalidated'), route_match.route.nodes.length);

			const page_url = new URL(request.url);
			page_url.pathname = add_base(page_pathname);
			page_url.searchParams.delete('x-sveltekit-invalidated');
			page_url.searchParams.delete('x-sveltekit-trailing-slash');

			const nodes = [];
			const parent_data = {};
			const should_load = get_required_workers(route_match.route.nodes, invalidated);
			let handled = false;

			for (let i = 0; i < route_match.route.nodes.length; i += 1) {
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
				const data = await node.worker.load({
					request,
					url: make_trackable_url(page_url, uses),
					route: track_route({ id: route_match.route.id }, uses),
					params: track_params(route_match.params, uses),
					network: get_network_state(),
					invalidated,
					parent: async () => {
						uses.parent = true;
						return { ...parent_data };
					},
					server: (options) => fetch_with_options(request, options)
				});

				if (!invalidated[i]) {
					nodes[i] = { type: 'skip' };
				} else {
					nodes[i] = {
						type: 'data',
						data,
						uses: serialize_uses(uses)
					};
				}

				if (data && typeof data === 'object') {
					Object.assign(parent_data, data);
				}
			}

			if (!handled) return null;

			return new Response(render_data_response(nodes), {
				headers: {
					'content-type': 'application/json',
					'cache-control': 'private, no-store',
					'x-sveltekit-worker': '1'
				}
			});
		}

		async function resolve_worker_action(request) {
			const request_url = new URL(request.url);
			const page_pathname = decode_pathname(strip_base(request_url.pathname));
			const route_match = find_worker_route(page_pathname);
			if (!route_match) return null;

			const node = route_match.route.nodes[route_match.route.nodes.length - 1];
			const actions = node?.worker?.actions;
			if (!actions) return null;

			const action_name = get_action_name(request_url);
			const action = actions[action_name];
			if (!action) {
				return action_response({
					type: 'error',
					status: 404,
					error: { message: \`No worker action with name '\${action_name}' found\` }
				});
			}

			if (!is_form_content_type(request)) {
				return action_response({
					type: 'error',
					status: 415,
					error: {
						message: \`Form actions expect form-encoded data - received \${request.headers.get('content-type')}\`
					}
				});
			}

			const server_request = request.clone();
			const page_url = new URL(request.url);

			try {
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
			return request.method === 'POST' && request.headers.get('x-sveltekit-action') === 'true';
		}

		function get_action_name(url) {
			let name = 'default';

			for (const param of url.searchParams) {
				if (param[0].startsWith('/')) {
					name = param[0].slice(1);
					break;
				}
			}

			return name;
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
				const params = exec_params(match, route.params);
				if (!params) continue;

				return {
					route,
					params: decode_params(params)
				};
			}
		}

		function exec_params(match, params) {
			const result = {};
			const values = match.slice(1);

			const values_needing_match = values.filter((value) => value !== undefined);
			let buffered = 0;

			for (let i = 0; i < params.length; i += 1) {
				const param = params[i];
				let value = values[i - buffered];

				if (param.chained && param.rest && buffered) {
					value = values
						.slice(i - buffered, i + 1)
						.filter((s) => s)
						.join('/');

					buffered = 0;
				}

				if (value === undefined) {
					if (param.rest) {
						value = '';
					} else {
						continue;
					}
				}

				if (!param.matcher || param.matcher(value)) {
					result[param.name] = value;

					const next_param = params[i + 1];
					const next_value = values[i + 1];
					if (next_param && !next_param.rest && next_param.optional && next_value && param.chained) {
						buffered = 0;
					}

					if (
						!next_param &&
						!next_value &&
						Object.keys(result).length === values_needing_match.length
					) {
						buffered = 0;
					}
					continue;
				}

				if (param.optional && param.chained) {
					buffered++;
					continue;
				}

				return;
			}

			if (buffered) return;
			return result;
		}

		function decode_params(params) {
			for (const key in params) {
				params[key] = decodeURIComponent(params[key]);
			}

			return params;
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

		function render_data_response(nodes) {
			return '{"type":"data","nodes":[' + nodes.map((node) => {
				if (!node || node.type === 'skip') return JSON.stringify(node);
				return '{"type":"data","data":' + devalue.stringify(node.data) + ',"uses":' + JSON.stringify(node.uses) + '}';
			}).join(',') + ']}\\n';
		}

		function action_response(result) {
			const normalized = normalize_action_result(result);
			const body = serialize_action_result(normalized);

			return new Response(body + '\\n', {
				status: normalized.type === 'error' ? normalized.status : 200,
				headers: {
					'content-type': 'application/json',
					'cache-control': 'private, no-store',
					'x-sveltekit-worker': '1'
				}
			});
		}

		function normalize_action_result(result) {
			if (is_action_result(result)) {
				if (result.type === 'error') {
					return {
						type: 'error',
						status: is_error_status(result.status) ? result.status : 500,
						error: result.error
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

			return {
				type: 'success',
				status: result ? 200 : 204,
				data: result
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

			return {
				type: 'error',
				status: is_error_status(error?.status) ? error.status : 500,
				error: serialize_error(error)
			};
		}

		function serialize_action_result(result) {
			if (result.type === 'success' || result.type === 'failure') {
				return JSON.stringify({
					type: result.type,
					status: result.status,
					data: devalue.stringify(result.data)
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
			if (result.type !== 'success' && result.type !== 'failure' && result.type !== 'redirect' && result.type !== 'error') return false;
			if (result.type === 'error') return true;
			return typeof result.status === 'number';
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
			if (error instanceof Error) {
				return { message: error.message };
			}

			if (error && typeof error === 'object' && 'body' in error) {
				return error.body;
			}

			return error ?? { message: 'Internal Error' };
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
			if (!options.timeout && !options.signal) return fetch(request);

			const controller = new AbortController();
			const timeout = options.timeout
				? setTimeout(() => controller.abort(), options.timeout)
				: null;

			options.signal?.addEventListener('abort', () => controller.abort(), { once: true });

			return fetch(request, { signal: controller.signal }).finally(() => {
				if (timeout) clearTimeout(timeout);
			});
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
