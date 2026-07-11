/** @type {import('./$worker-types').PageWorkerLoad} */
export function load({ params }) {
	return {
		matcher: 'numeric',
		id: params.id
	};
}
