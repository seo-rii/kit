/** @type {import('./$types').PageWorkerLoad} */
export async function load({ network, parent, route, url }) {
	const data = await parent();
	const tracked = url.searchParams.get('tracked') ?? 'none';

	return {
		message: `worker data for ${route.id}`,
		source: 'worker',
		stale: true,
		network: network.status,
		path: url.pathname,
		tracked,
		layoutSeen: data.layoutSource
	};
}
