/**
 * @param {import('./$types').PageServerLoadEvent} event
 * @returns {import('../../data.js').MatcherData}
 */
export function load({ params, route }) {
	return {
		source: 'server',
		match: 'numeric',
		value: params.id,
		valueType: typeof params.id,
		routeId: route.id
	};
}
