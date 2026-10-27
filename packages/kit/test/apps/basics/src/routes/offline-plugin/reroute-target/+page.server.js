/**
 * @param {import('./$types').PageServerLoadEvent} event
 * @returns {import('../data.js').RerouteData}
 */
export function load({ route, url }) {
	return {
		source: 'server',
		routeId: route.id,
		pathname: url.pathname
	};
}
