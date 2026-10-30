/** @import { DataFallbackHandlers, DataFallbackLoad } from './fallback.js' */
/** @import { ServerDataNode, ServerDataSkippedNode, ServerErrorNode, Uses } from 'types' */
import { exec } from '../../../utils/routing.js';
import { decode_pathname, make_trackable, normalize_path } from '../../../utils/url.js';
import { has_data_suffix, strip_data_suffix } from '../../../pathname.js';
import { INVALIDATED_PARAM, TRAILING_SLASH_PARAM, validate_load_response } from '../../shared.js';
import { stream_text } from '../../utils.js';
import { create_data_serializer } from '../../shared/serialize_data.js';

const missing_parent = Symbol('missing parent fallback');

/**
 * @typedef {{ id: string; kind: 'layout' | 'page'; server: boolean; slash?: import('types').TrailingSlash }} FallbackNode
 * @typedef {{ id: string; pattern: RegExp; params: import('types').RouteParam[]; nodes: (FallbackNode | null)[]; unsupported?: boolean }} FallbackRoute
 */

/**
 * This factory stays internal; consumers register loads without seeing node indexes or wire data.
 * @param {FallbackRoute[]} routes
 * @param {{ reroute?: import('@sveltejs/kit/hooks').Reroute; transport?: import('@sveltejs/kit/hooks').Transport }} hooks
 * @param {Record<string, import('@sveltejs/kit/params').ParamMatcher>} matchers
 * @param {{ base: string; version: string; versionCheck: boolean; origin: string }} options
 * @returns {(request: Request, handlers: DataFallbackHandlers) => Promise<Response | null>}
 */
export function create_data_resolver(routes, hooks, matchers, options) {
	const encoders = Object.fromEntries(
		Object.entries(hooks.transport ?? {}).map(([key, value]) => [key, value.encode])
	);

	return async (request, handlers) => {
		if (request.method !== 'GET') return null;
		request.signal.throwIfAborted();
		const url = new URL(request.url);
		if (url.origin !== options.origin || !has_data_suffix(url.pathname)) return null;
		if (options.base && !url.pathname.startsWith(options.base + '/')) return null;
		const invalidated_value = url.searchParams.get(INVALIDATED_PARAM);
		url.pathname =
			strip_data_suffix(url.pathname) +
				(url.searchParams.get(TRAILING_SLASH_PARAM) === '1' ? '/' : '') || '/';
		url.searchParams.delete(INVALIDATED_PARAM);
		url.searchParams.delete(TRAILING_SLASH_PARAM);

		const rerouted = await hooks.reroute?.({
			url: new URL(url),
			fetch: (input, init) => fetch(input instanceof Request ? input : new URL(input, url), init)
		});
		const pathname = decode_pathname((rerouted ?? url.pathname).slice(options.base.length) || '/');
		for (const route of routes) {
			const match = route.pattern.exec(pathname);
			if (!match) continue;
			const params = exec(match, route.params, matchers);
			if (!params) continue;
			if (route.unsupported) return null;
			// The base root always needs a slash, including grouped roots and routes that
			// explicitly set trailingSlash to 'never'. Match the server's original-URL check.
			const slash =
				options.base && (url.pathname === options.base || url.pathname === options.base + '/')
					? 'always'
					: route.nodes.reduce(
							(value, node) => node?.slash ?? value,
							/** @type {import('types').TrailingSlash} */ ('never')
						);
			url.pathname = normalize_path(url.pathname, slash);

			const invalidated = route.nodes.map(
				(_, i) => !invalidated_value || invalidated_value[i] === '1'
			);
			const loads = route.nodes.map((node) => {
				if (!node || !Object.hasOwn(handlers, node.id)) return undefined;
				return handlers[node.id][node.kind];
			});
			// Decide whether the entire response can be produced before invoking user code.
			if (route.nodes.some((node, i) => invalidated[i] && node?.server && !loads[i])) return null;
			if (!loads.some((load, i) => load && invalidated[i])) return null;

			/** @type {Promise<Record<string, any>>[]} */
			const promises = [];
			/** @type {Promise<ServerDataNode>[]} */
			const results = [];

			/** @param {number} index @returns {Promise<ServerDataNode>} */
			const run = (index) => {
				return (results[index] ??= (async () => {
					request.signal.throwIfAborted();
					const node = /** @type {FallbackNode} */ (route.nodes[index]);
					const load = /** @type {DataFallbackLoad} */ (loads[index]);
					/** @type {Uses} */
					const uses = {
						dependencies: new Set(),
						params: new Set(),
						parent: false,
						route: false,
						url: false,
						search_params: new Set()
					};
					const data = await load({
						request,
						url: make_trackable(
							url,
							() => (uses.url = true),
							(name) => uses.search_params.add(name)
						),
						params: new Proxy(params, {
							get(target, key) {
								if (typeof key === 'string') uses.params.add(key);
								return Reflect.get(target, key);
							}
						}),
						route: {
							get id() {
								uses.route = true;
								return route.id;
							}
						},
						node: { id: node.id, kind: node.kind },
						parent: async () => {
							uses.parent = true;
							return (promises[index] ??= (async () => {
								const parent = {};
								for (let i = 0; i < index; i += 1) {
									if (loads[i]) Object.assign(parent, (await run(i)).data);
									else if (route.nodes[i]?.server) throw missing_parent;
								}
								return parent;
							})());
						},
						network: {
							status:
								typeof navigator === 'undefined'
									? 'unknown'
									: navigator.onLine
										? 'online'
										: 'offline'
						},
						server: (retry) => retry_request(request, retry)
					});
					validate_load_response(data, `data fallback for ${node.id}`);
					/** @type {ServerDataNode} */
					const result = {
						type: 'data',
						data: data ?? null,
						uses,
						...(node.slash ? { slash: node.slash } : {})
					};
					if (!invalidated[index] || request.signal.aborted) {
						try {
							// Lazy parents may not appear in the response. Observe their deferred
							// values before another load yields, without adding response chunks.
							(invalidated[index] ? serializer : discarded_serializer).add_node(index, result);
						} finally {
							request.signal.throwIfAborted();
						}
					}
					return result;
				})());
			};

			const serializer = create_data_serializer({
				encoders,
				onError: serialize_error,
				onSerializationError: (error) => error
			});
			const discarded_serializer = create_data_serializer({
				encoders,
				onError: serialize_error,
				onSerializationError: (error) => error
			});
			try {
				let failed = false;
				for (let i = 0; i < route.nodes.length; i += 1) {
					/** @type {ServerDataNode | ServerDataSkippedNode | ServerErrorNode | null} */
					let node = null;
					if (failed || !invalidated[i]) {
						node = { type: 'skip' };
					} else if (loads[i]) {
						try {
							node = await run(i);
						} catch (error) {
							request.signal.throwIfAborted();
							if (error === missing_parent) return null;
							if (is_redirect(error))
								return response(
									JSON.stringify({
										type: 'redirect',
										status: error.status,
										location: error.location
									}),
									'application/json'
								);
							node = { type: 'error', error: serialize_error(error) };
							failed = true;
						}
					} else if (route.nodes[i]?.slash) {
						// A server module can export trailingSlash without a load. Its empty
						// data node still carries the URL policy used by client navigation.
						node = {
							type: 'data',
							data: null,
							uses: {
								dependencies: new Set(),
								params: new Set(),
								parent: false,
								route: false,
								url: false,
								search_params: new Set()
							},
							slash: route.nodes[i]?.slash
						};
					}
					// Attach deferred rejection handlers before waiting for another load, including
					// when a later load redirects or makes the fallback decline the request.
					serializer.add_node(i, node);
				}
				const { data, chunks } = serializer.get_data();
				return chunks
					? response(stream_text(data, chunks), 'text/sveltekit-data')
					: response(data, 'application/json');
			} catch (error) {
				request.signal.throwIfAborted();
				const serialized = serialize_error(error);
				return response(JSON.stringify(serialized), 'application/json', serialized.status);
			}
		}
		return null;
	};

	/** @param {BodyInit} body @param {string} content_type @param {number} [status] */
	function response(body, content_type, status = 200) {
		const headers = new Headers({
			'content-type': content_type,
			'cache-control': 'private, no-store',
			'x-sveltekit-worker': '1'
		});
		if (options.versionCheck) headers.set('x-sveltekit-version', options.version);
		return new Response(body, { status, headers });
	}
}

/** @param {any} error @returns {error is {status: number; location: string}} */
function is_redirect(error) {
	return (
		error &&
		typeof error === 'object' &&
		error.status >= 300 &&
		error.status <= 308 &&
		typeof error.location === 'string'
	);
}

/** @param {any} error @returns {App.Error} */
function serialize_error(error) {
	const status =
		typeof error?.status === 'number' && error.status >= 400 && error.status <= 599
			? error.status
			: 500;
	return {
		...(error?.body ?? {}),
		message: error?.body?.message ?? error?.message ?? 'Internal Error',
		status
	};
}

/** @param {Request} request @param {{timeout?: number; signal?: AbortSignal}} [options] */
async function retry_request(request, options = {}) {
	if (options.timeout !== undefined && (!Number.isFinite(options.timeout) || options.timeout < 0))
		throw new RangeError('timeout must be a non-negative finite number');
	const controller = new AbortController();
	// Keep cancellation linked after fetch resolves, while the caller consumes the raw body.
	const signal = AbortSignal.any(
		[request.signal, options.signal, controller.signal].filter((signal) => signal !== undefined)
	);
	const timer =
		options.timeout === undefined
			? null
			: setTimeout(
					() => controller.abort(new DOMException('Timed out', 'TimeoutError')),
					options.timeout
				);
	try {
		return await fetch(request, { signal });
	} finally {
		// The timeout bounds the wait for response headers; caller cancellation also covers the body.
		if (timer !== null) clearTimeout(timer);
	}
}
