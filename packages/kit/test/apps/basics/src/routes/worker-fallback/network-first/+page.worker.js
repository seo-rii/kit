/** @type {import('./$worker-types').PageWorkerLoad} */
export function load({ network }) {
	return {
		source: 'network-first-worker',
		network: network.status
	};
}
