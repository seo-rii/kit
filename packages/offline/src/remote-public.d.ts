/** The classification supplied by SvelteKit's experimental service-worker API. */
export interface RemoteRequestClassification {
	kind: 'data' | 'remote-query' | 'remote-live' | 'remote-mutation' | 'action' | 'other';
	/** Canonical absolute URL, including the complete query string but no fragment, or null. */
	key: string | null;
}

export interface RemoteCacheOptions {
	/** Use `classifyRequest` from `$app/service-worker`; it excludes cross-origin requests. */
	classifyRequest: (request: Request) => RemoteRequestClassification;
	/** Required application cache name containing the deployment/schema version. */
	cacheName: string;
	/**
	 * Required opaque account/session scope. Rotate this when the authenticated identity
	 * changes. Do not put credentials in the name or reuse one scope for different users.
	 */
	scope: string;
	fetch?: (request: Request) => Promise<Response>;
	storage?: Pick<CacheStorage, 'open' | 'delete'>;
}

export interface RemoteCache {
	/**
	 * Fetch once, falling back to a fresh cached remote GET only after a transport failure.
	 * A response opts in with a positive `Cache-Control: max-age`; `no-store`, `no-cache`,
	 * `Vary: *`, HTTP errors, and event streams are never cached. Variants on browser-controlled
	 * request headers (including Cookie, Referer, Origin, Accept-Encoding, User-Agent, Sec-*,
	 * and Proxy-*) are also rejected and removed from existing caches because their network
	 * values cannot be matched reliably. This includes responses whose compression middleware
	 * adds `Vary: Accept-Encoding`. Visible headers such as Accept-Language, Authorization,
	 * and application headers remain supported. `Age` and `Date` count toward expiry.
	 * Cached payloads remain opaque and are never deserialized.
	 * Remote GET network attempts use `cache: 'no-store'` so the browser HTTP cache
	 * cannot serve an old value after this coordinator invalidates CacheStorage.
	 *
	 * Mutations and actions invalidate this namespace before and after their one network
	 * attempt, including failures. They are never queued, replayed, or reported as successful
	 * locally. Reads overlapping a mutation cannot populate or fall back to this cache.
	 */
	handle(request: Request): Promise<Response>;
	/**
	 * Discard this namespace and fence off pending reads. A storage failure disables caching
	 * for this instance, allowing network requests and their original failures to proceed.
	 */
	invalidate(): Promise<void>;
}

/** Create one cache coordinator per namespace for a service-worker lifetime. */
export function createRemoteCache(options: RemoteCacheOptions): RemoteCache;
