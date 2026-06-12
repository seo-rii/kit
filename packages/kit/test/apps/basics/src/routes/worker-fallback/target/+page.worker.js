/** @type {import('./$types').PageWorkerLoad} */
export function load({ network, route }) {
	return {
		message: `worker data for ${route.id}`,
		source: 'worker',
		stale: true,
		network: network.status
	};
}
