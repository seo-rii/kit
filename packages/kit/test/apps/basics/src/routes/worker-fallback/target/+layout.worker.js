/** @type {import('./$types').LayoutWorkerLoad} */
export function load({ network }) {
	return {
		layoutSource: 'layout-worker',
		layoutNetwork: network.status
	};
}
