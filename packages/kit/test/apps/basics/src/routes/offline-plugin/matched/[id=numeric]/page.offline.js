/**
 * @type {import('$app/service-worker').DataFallbackLoad}
 * @returns {import('../../data.js').MatcherData}
 */
export function load({ params, route }) {
	return {
		source: 'offline',
		match: 'numeric',
		value: params.id,
		valueType: typeof params.id,
		routeId: route.id
	};
}
