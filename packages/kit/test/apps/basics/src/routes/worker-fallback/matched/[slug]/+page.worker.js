/** @type {import('./$types').PageWorkerLoad} */
export function load({ params }) {
	return {
		matcher: 'slug',
		slug: params.slug
	};
}
