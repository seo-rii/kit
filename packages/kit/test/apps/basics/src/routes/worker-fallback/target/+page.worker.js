/** @type {import('./$types').PageWorkerLoad} */
export async function load({ network, parent, route }) {
	const data = await parent();

	return {
		message: `worker data for ${route.id}`,
		source: 'worker',
		stale: true,
		network: network.status,
		layoutSeen: data.layoutSource
	};
}
