import { expect, test } from 'vitest';
import { create_request_classifier } from './requests.js';

const origin = 'https://example.com';
const classify = create_request_classifier({ origin, base: '/app', appDir: '_custom' });

/**
 * @param {string} path
 * @param {RequestInit} [init]
 */
function request(path, init) {
	return new Request(new URL(path, origin), init);
}

test.each([
	'/app/items/__data.json?filter=a&x-sveltekit-invalidated=01',
	'/app/about.html__data.json'
])('classifies data requests and preserves their complete cache identity: %s', (path) => {
	const input = request(path);
	expect(classify(input)).toEqual({ kind: 'data', key: input.url });
});

test.each(['POST', 'PUT', 'DELETE', 'HEAD'])(
	'does not treat %s requests to a data URL as reusable data',
	(method) => {
		expect(classify(request('/app/items/__data.json', { method }))).toEqual({
			kind: 'other',
			key: null
		});
	}
);

test.each([
	'https://other.example/app/items/__data.json',
	'https://other.example/app/_custom/remote/query',
	'https://example.com:444/app/_custom/remote/query',
	'/application/items/__data.json',
	'/application/_custom/remote/query',
	'/app/_app/remote/query',
	'/app/_custom/remoteish/query',
	'/app/_custom/remote',
	'/app/items/__data.json/extra',
	'/app/items'
])('leaves requests outside the configured Kit endpoints untouched: %s', (path) => {
	expect(classify(request(path))).toEqual({ kind: 'other', key: null });
});

test('classifies remote GETs using the opaque URL without decoding their arguments', () => {
	const input = request('/app/_custom/remote/module/query?payload=%2Fopaque%2B%3D&variant=2');
	expect(classify(input)).toEqual({ kind: 'remote-query', key: input.url });
});

test.each([
	'/app/_custom/remote/module/query?payload=%23opaque&variant=2',
	'/app/items/__data.json?filter=%23opaque&x-sveltekit-invalidated=01'
])('uses one cache identity for URL fragments without changing the request: %s', (path) => {
	const expected = classify(request(path));
	for (const fragment of ['#one', '#two', '#']) {
		const input = request(path + fragment);
		const original_url = input.url;
		expect(classify(input)).toEqual(expected);
		expect(input.url).toBe(original_url);
	}
	expect(expected.key).toBe(new URL(path, origin).href);
	expect(classify(request(path + '&variant=3')).key).not.toBe(expected.key);
});

test.each(['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'])(
	'classifies remote %s requests as mutations without consuming the body',
	(method) => {
		const input = request('/app/_custom/remote/module/command', { method, body: 'opaque' });
		expect(classify(input)).toEqual({ kind: 'remote-mutation', key: null });
		expect(input.bodyUsed).toBe(false);
	}
);

test.each([
	'text/event-stream',
	'application/json, text/event-stream; charset=utf-8',
	'Text/Event-Stream ; charset=utf-8'
])('keeps live queries out of the response cache: %s', (accept) => {
	expect(classify(request('/app/_custom/remote/module/query', { headers: { accept } }))).toEqual({
		kind: 'remote-live',
		key: null
	});
});

test('does not let an SSE Accept header hide a remote mutation', () => {
	expect(
		classify(
			request('/app/_custom/remote/module/command', {
				method: 'POST',
				headers: { accept: 'text/event-stream', 'x-sveltekit-action': 'true' }
			})
		)
	).toEqual({ kind: 'remote-mutation', key: null });
});

test.each([undefined, 'text/event-stream'])('ignores remote HEADs with Accept %s', (accept) => {
	expect(
		classify(
			request('/app/_custom/remote/module/query', {
				method: 'HEAD',
				headers: accept ? { accept } : undefined
			})
		)
	).toEqual({ kind: 'other', key: null });
});

test.each(['/app', '/app/', '/app/items?/save'])(
	'recognizes enhanced form actions inside the app, including its base root: %s',
	(path) => {
		expect(
			classify(request(path, { method: 'POST', headers: { 'x-sveltekit-action': 'true' } }))
		).toEqual({ kind: 'action', key: null });
	}
);

test.each([
	{ method: 'GET', headers: { 'x-sveltekit-action': 'true' } },
	{ method: 'POST' },
	{ method: 'POST', headers: { 'x-sveltekit-action': 'false' } }
])('does not classify ordinary document requests as actions: %j', (init) => {
	expect(classify(request('/app/items', init))).toEqual({ kind: 'other', key: null });
});

test('supports an app served from the origin root', () => {
	const classify = create_request_classifier({ origin, base: '', appDir: '_app' });
	const input = request('/_app/remote/module/query');
	expect(classify(input)).toEqual({ kind: 'remote-query', key: input.url });
	expect(classify(request('/__data.json'))).toEqual({
		kind: 'data',
		key: `${origin}/__data.json`
	});
});
