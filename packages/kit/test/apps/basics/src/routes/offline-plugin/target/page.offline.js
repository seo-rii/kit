/**
 * @type {import('$app/service-worker').DataFallbackLoad}
 * @returns {Promise<import('../data.js').PageData>}
 */
export async function load({ network, parent, route, url }) {
	const data = await parent();

	return {
		message: `offline data for ${route.id}`,
		source: 'offline',
		network: network.status,
		path: url.pathname,
		tracked: url.searchParams.get('tracked') ?? 'none',
		parentSource: data.layoutSource,
		routeId: route.id
	};
}
