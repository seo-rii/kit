/** An explicit, browser-safe replacement for one server load. Experimental. */
export type DataFallbackLoad = (
	event: DataFallbackEvent
) => Record<string, any> | void | Promise<Record<string, any> | void>;

/** Keys are source route IDs, including groups and layout-only directories. */
export type DataFallbackHandlers = Record<
	string,
	{ layout?: DataFallbackLoad; page?: DataFallbackLoad }
>;

export interface DataFallbackEvent {
	request: Request;
	url: URL;
	params: Record<string, any>;
	route: { id: string };
	node: { id: string; kind: 'layout' | 'page' };
	parent(): Promise<Record<string, any>>;
	network: { status: 'online' | 'offline' | 'unknown' };
	/**
	 * Retry the original data request and return the raw response. `timeout` limits the wait
	 * for response headers. The request and caller signals also cancel response body reads.
	 */
	server(options?: { timeout?: number; signal?: AbortSignal }): Promise<Response>;
}

/**
 * Produce a data-navigation response using explicitly registered fallback loads.
 * Requires `experimental.serviceWorkerFallbacks`. Returns `null` for unsupported
 * requests, unmatched routes, or missing required server-load replacements.
 * Does not fetch, cache, replay mutations, or render document requests.
 */
export function resolveData(
	request: Request,
	handlers: DataFallbackHandlers
): Promise<Response | null>;

export type WorkerRequestInfo = {
	kind: 'data' | 'remote-query' | 'remote-live' | 'remote-mutation' | 'action' | 'other';
	/** Opaque, version-dependent request identity. Do not parse it. */
	key: string | null;
};

/** Classify requests for an opt-in offline policy. Does not authorize caching or replay. */
export function classifyRequest(request: Request): WorkerRequestInfo;
