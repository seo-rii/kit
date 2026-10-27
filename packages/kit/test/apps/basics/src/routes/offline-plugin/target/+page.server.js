/**
 * @param {import('./$types').PageServerLoadEvent} event
 * @returns {Promise<import('../data.js').PageData>}
 */
export async function load({ parent, route, url }) {
	const data = await parent();

	return {
		message: `server data for ${route.id}`,
		source: 'server',
		network: 'server',
		path: url.pathname,
		tracked: url.searchParams.get('tracked') ?? 'none',
		parentSource: data.layoutSource,
		routeId: route.id
	};
}
