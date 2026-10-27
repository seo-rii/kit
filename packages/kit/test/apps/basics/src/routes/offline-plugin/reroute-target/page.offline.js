/**
 * @type {import('$app/service-worker').DataFallbackLoad}
 * @returns {import('../data.js').RerouteData}
 */
export function load({ route, url }) {
	return {
		source: 'offline',
		routeId: route.id,
		pathname: url.pathname
	};
}
