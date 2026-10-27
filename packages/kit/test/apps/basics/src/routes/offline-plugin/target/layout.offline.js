/**
 * @type {import('$app/service-worker').DataFallbackLoad}
 * @returns {import('../data.js').LayoutData}
 */
export function load({ network }) {
	return {
		layoutSource: 'offline-layout',
		layoutNetwork: network.status
	};
}
