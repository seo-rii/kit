/**
 * @param {import('./$types').PageServerLoadEvent} event
 * @returns {import('../../data.js').MatcherData}
 */
export function load({ params, route }) {
	return {
		source: 'server',
		match: 'slug',
		value: params.slug,
		valueType: typeof params.slug,
		routeId: route.id
	};
}
