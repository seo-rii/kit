import type { DataFallbackHandlers } from '$app/service-worker';

/** Options for the experimental offline read policy. */
export interface OfflineHandlerOptions {
	/**
	 * SvelteKit's experimental `resolveData` function from `$app/service-worker`.
	 * Kit owns route matching and response serialization; the package only selects
	 * when to use a local read fallback.
	 */
	resolveData: (request: Request, handlers: DataFallbackHandlers) => Promise<Response | null>;
	/** Explicit local layout/page loaders, keyed by SvelteKit route ID. */
	handlers: DataFallbackHandlers;
	/** Network implementation, for example a wrapper around `globalThis.fetch`. */
	fetch?: (request: Request) => Promise<Response>;
	/**
	 * `network-first` falls back only when the network rejects, excluding aborts.
	 * `worker-first` tries local GET data first and uses the network for unmatched
	 * requests. Mutations always go directly to the network in either strategy.
	 * @default 'network-first'
	 */
	strategy?: 'network-first' | 'worker-first';
}

/**
 * Create a request handler using SvelteKit's experimental data resolver.
 * Register the returned function with the service worker's `fetch` listener.
 */
export function createOfflineHandler(
	options: OfflineHandlerOptions
): (request: Request) => Promise<Response>;
