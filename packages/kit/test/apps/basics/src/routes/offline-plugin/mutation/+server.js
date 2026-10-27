import { json } from '@sveltejs/kit';

/** @type {import('./$types').RequestHandler} */
export async function POST({ request }) {
	return json({ state: 'confirmed', message: await request.text() });
}
