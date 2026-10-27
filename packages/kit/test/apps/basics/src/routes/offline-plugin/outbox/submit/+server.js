import { json } from '@sveltejs/kit';

// Test-only, in-memory server deduplication. A real application must bind the
// scope to authenticated identity and atomically persist effects and receipts.
/** @type {Map<string, { payload: string; requests: number; receipt: import('sveltekit-offline/outbox').OutboxReceipt }>} */
const operations = new Map();

/** @type {import('./$types').RequestHandler} */
export async function POST({ request }) {
	const { scope, id, payload } = await request.json();
	if (typeof scope !== 'string' || !scope || typeof id !== 'string' || !id) {
		return json({ status: 'rejected', reason: 'missing-operation-identity' }, { status: 400 });
	}

	const key = JSON.stringify([scope, id]);
	const encoded = JSON.stringify(payload);
	const existing = operations.get(key);
	if (existing) {
		existing.requests += 1;
		if (existing.payload !== encoded) {
			return json({ status: 'rejected', reason: 'operation-payload-conflict' }, { status: 409 });
		}
		return json(existing.receipt);
	}

	/** @type {import('sveltekit-offline/outbox').OutboxReceipt} */
	const receipt = { status: 'confirmed', receipt: { scope, id, effect: 1, payload } };
	// No await separates this lookup and insertion, making the fixture's effect
	// atomic within its single test server process.
	operations.set(key, { payload: encoded, requests: 1, receipt });
	return json(receipt, {
		headers: {
			'x-outbox-test-drop-response':
				request.headers.get('x-outbox-test-lose-response') === 'true' ? '1' : '0'
		}
	});
}

/** @type {import('./$types').RequestHandler} */
export function GET({ url }) {
	const key = JSON.stringify([url.searchParams.get('scope'), url.searchParams.get('id')]);
	const operation = operations.get(key);
	return json(
		{ effects: operation ? 1 : 0, requests: operation?.requests ?? 0 },
		{
			headers: { 'cache-control': 'no-store' }
		}
	);
}
