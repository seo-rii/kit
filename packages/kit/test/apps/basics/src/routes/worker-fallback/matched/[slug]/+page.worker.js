/** @type {import('./$worker-types').PageWorkerLoad} */
export function load({ params }) {
	return {
		matcher: 'slug',
		slug: params.slug
	};
}
