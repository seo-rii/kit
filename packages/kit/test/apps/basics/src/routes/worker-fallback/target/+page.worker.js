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

/** @type {import('./$types').PageWorkerActions} */
export const actions = {
	async submit({ action, network, request, route }) {
		const form = await request.formData();

		return {
			type: 'failure',
			status: 422,
			data: {
				action,
				message: form.get('message'),
				network: network.status,
				route: route.id
			}
		};
	}
};
