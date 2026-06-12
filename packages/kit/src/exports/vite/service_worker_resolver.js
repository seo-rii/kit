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
				params: ${s(route.params)},
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
				const response = await resolve_worker_data(request);
				if (response) return response;

				return fetch(request);
			}

			try {
				return await fetch(request);
			} catch (error) {
				const response = await resolve_worker_data(request);
				if (response) return response;
				throw error;
			}
		}

		async function resolve_worker_data(request) {
			if (request.method !== 'GET') return null;

			const request_url = new URL(request.url);
			const pathname = strip_base(request_url.pathname);
			const page_pathname = remove_data_suffix(pathname);
			if (!page_pathname) return null;

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

				if (!node?.worker) {
					if (node?.server) return null;
					nodes[i] = null;
					continue;
				}

				handled = true;
				let uses_parent = false;
				const data = await node.worker.load({
					request,
					url: page_url,
					route: { id: route_match.route.id },
					params: route_match.params,
					network: get_network_state(),
					invalidated,
					parent: async () => {
						uses_parent = true;
						return { ...parent_data };
					},
					server: (options) => fetch_with_options(request, options)
				});

				nodes[i] = {
					type: 'data',
					data,
					uses: uses_parent ? { parent: 1 } : {}
				};

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

		function find_worker_route(pathname) {
			for (const route of worker_routes) {
				const match = route.pattern.exec(pathname);
				if (!match) continue;

				return {
					route,
					params: exec_params(match, route.params)
				};
			}
		}

		function exec_params(match, params) {
			const result = {};
			const values = match.slice(1);

			for (let i = 0; i < params.length; i += 1) {
				const value = values[i];
				if (value === undefined) continue;
				result[params[i].name] = decodeURIComponent(value);
			}

			return result;
		}

		function render_data_response(nodes) {
			return '{"type":"data","nodes":[' + nodes.map((node) => {
				if (!node || node.type === 'skip') return JSON.stringify(node);
				return '{"type":"data","data":' + devalue.stringify(node.data) + ',"uses":' + JSON.stringify(node.uses) + '}';
			}).join(',') + ']}\\n';
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
