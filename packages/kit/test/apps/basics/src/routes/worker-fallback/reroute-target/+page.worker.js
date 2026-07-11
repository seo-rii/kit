/** @type {import('./$worker-types').PageWorkerLoad} */
export function load({ route }) {
	return {
		source: 'rerouted-worker',
		route: route.id
	};
}
