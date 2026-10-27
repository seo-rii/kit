import { version } from '$app/env';
import { classifyRequest, resolveData } from '$app/service-worker';
import { createOfflineHandler } from 'sveltekit-offline';
import { createRemoteCache } from 'sveltekit-offline/remote';
import { load as target_layout } from './routes/offline-plugin/target/layout.offline.js';
import { load as target_page } from './routes/offline-plugin/target/page.offline.js';
import { load as streaming_page } from './routes/offline-plugin/streaming/page.offline.js';
import { load as numeric_page } from './routes/offline-plugin/matched/[id=numeric]/page.offline.js';
import { load as slug_page } from './routes/offline-plugin/matched/[slug]/page.offline.js';
import { load as rerouted_page } from './routes/offline-plugin/reroute-target/page.offline.js';

/** @type {import('$app/service-worker').DataFallbackLoad} */
const root_layout = () => ({ rootlayout: 'rootlayout' });

const handlers = {
	'/': { layout: root_layout },
	'/offline-plugin/target': { layout: target_layout, page: target_page },
	'/offline-plugin/streaming': { page: streaming_page },
	'/offline-plugin/matched/[id=numeric]': { page: numeric_page },
	'/offline-plugin/matched/[slug]': { page: slug_page },
	'/offline-plugin/reroute-target': { page: rerouted_page }
};

/** @type {typeof fetch} */
const test_fetch = async (input, init) => {
	const request = new Request(input, init);
	const response = request.headers.get('x-offline-test-response');

	if (response === '503') {
		return new Response('unavailable', {
			status: 503,
			headers: { 'x-offline-test-network': '1' }
		});
	}

	if (response === 'transport-error') {
		throw new TypeError('Simulated transport failure');
	}

	return fetch(request);
};

const network_first = createOfflineHandler({ resolveData, handlers, fetch: test_fetch });
const worker_first = createOfflineHandler({
	resolveData,
	handlers,
	fetch: test_fetch,
	strategy: 'worker-first'
});

const remote_cache = createRemoteCache({
	classifyRequest,
	cacheName: `offline-plugin-remotes-${version}`,
	scope: 'offline-plugin-test-fixture'
});

/**
 * @param {Request} request
 * @returns {Promise<Response> | null}
 */
export function handle_offline_plugin_request(request) {
	const { kind } = classifyRequest(request);
	if (kind.startsWith('remote-') || kind === 'action') {
		// Keep every remote response out of the test app's generic asset cache.
		return remote_cache.handle(request);
	}

	const url = new URL(request.url);
	if (url.origin !== location.origin || !url.pathname.startsWith('/offline-plugin/')) return null;

	return url.searchParams.get('strategy') === 'worker-first'
		? worker_first(request)
		: network_first(request);
}
