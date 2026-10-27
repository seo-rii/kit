/**
 * @type {import('$app/service-worker').DataFallbackLoad}
 * @returns {import('../../data.js').MatcherData}
 */
export function load({ params, route }) {
	return {
		source: 'offline',
		match: 'slug',
		value: params.slug,
		valueType: typeof params.slug,
		routeId: route.id
	};
}
