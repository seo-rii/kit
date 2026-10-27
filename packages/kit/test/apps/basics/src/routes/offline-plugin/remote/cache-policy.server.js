/**
 * Remote functions cannot call setHeaders. This fixture explicitly opts one
 * read into offline caching after Kit has produced its ordinary remote response.
 * @type {import('@sveltejs/kit/hooks').Handle}
 */
export async function offline_remote_cache_headers({ event, resolve }) {
	const response = await resolve(event);
	if (
		event.isRemoteRequest &&
		event.request.method === 'GET' &&
		new URL(event.request.url).pathname.endsWith('/offline_cached_items') &&
		response.ok
	) {
		response.headers.set('cache-control', 'private, max-age=60');
	}
	return response;
}
