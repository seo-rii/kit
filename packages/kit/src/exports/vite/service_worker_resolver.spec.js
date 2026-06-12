import { expect, test } from 'vitest';
import { create_service_worker_resolver } from './service_worker_resolver.js';

test('only imports matchers used by worker routes', () => {
	const nodes = [
		{
			depth: 0,
			server: 'src/routes/worker/[id=used]/+page.server.js',
			worker: 'src/routes/worker/[id=used]/+page.worker.js'
		},
		{
			depth: 0,
			server: 'src/routes/server/[id=unused]/+page.server.js'
		}
	];

	/** @type {import('types').ManifestData} */
	const manifest_data = {
		assets: [],
		hooks: {
			client: null,
			server: null,
			universal: null
		},
		matchers: {
			used: 'src/params/used.js',
			unused: 'src/params/unused.js'
		},
		nodes,
		routes: [
			{
				id: '/worker/[id=used]',
				parent: null,
				segment: '[id=used]',
				pattern: /^\/worker\/([^/]+?)\/?$/,
				params: [
					{
						name: 'id',
						matcher: 'used',
						optional: false,
						rest: false,
						chained: false
					}
				],
				page: {
					layouts: [],
					errors: [],
					leaf: 0
				},
				layout: null,
				error: null,
				leaf: nodes[0],
				endpoint: null
			},
			{
				id: '/server/[id=unused]',
				parent: null,
				segment: '[id=unused]',
				pattern: /^\/server\/([^/]+?)\/?$/,
				params: [
					{
						name: 'id',
						matcher: 'unused',
						optional: false,
						rest: false,
						chained: false
					}
				],
				page: {
					layouts: [],
					errors: [],
					leaf: 1
				},
				layout: null,
				error: null,
				leaf: nodes[1],
				endpoint: null
			}
		]
	};

	const code = create_service_worker_resolver(manifest_data);

	expect(code).toContain('/src/params/used.js');
	expect(code).not.toContain('/src/params/unused.js');
});
