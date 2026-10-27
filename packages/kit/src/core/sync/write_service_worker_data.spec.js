/** @import { ManifestData } from 'types' */
/** @import { Config } from '@sveltejs/kit/vite' */
/** @import { FallbackRoute } from '../../runtime/app/service-worker/data.js' */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { afterEach, expect, test, vi } from 'vitest';
import { create_data_resolver } from '../../runtime/app/service-worker/data.js';
import { process_config, validate_config } from '../config/index.js';
import { runtime_directory } from '../utils.js';
import create_manifest_data from './create_manifest_data/index.js';
import { write_service_worker_data } from './write_service_worker_data.js';

/** @type {string[]} */
const directories = [];
const origin = 'https://example.com';

afterEach(() => {
	for (const directory of directories.splice(0))
		fs.rmSync(directory, { recursive: true, force: true });
});

/**
 * @param {Record<string, string>} [files]
 * @param {Config} [options]
 */
function fixture(files = {}, options = {}) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kit worker manifest '));
	directories.push(root);
	for (const [name, content] of Object.entries(files)) {
		const file = path.join(root, name);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, content);
	}
	const config = process_config(
		validate_config({
			experimental: { serviceWorkerFallbacks: true },
			paths: { base: '/app' },
			appDir: '_custom',
			version: { name: 'deployment-A' },
			...options
		}),
		root
	);
	const output = path.join(config.outDir, 'generated', 'worker');
	const manifest = create_manifest_data(config, root);
	return { root, config, output, manifest };
}

/** @param {ReturnType<typeof fixture>} fixture */
function generate({ config, manifest, output, root }) {
	write_service_worker_data(config, manifest, output, root);
	return fs.readFileSync(path.join(output, 'service-worker-data.js'), 'utf8');
}

/**
 * Evaluate the generated module with its runtime factories injected. This checks the actual
 * routing graph passed to the worker without loading application modules in Node.
 * @param {string} source
 * @param {Record<string, unknown>} [bindings]
 */
function evaluate(source, bindings = {}) {
	const create_data_resolver = vi.fn(
		/** @param {Parameters<typeof import('../../runtime/app/service-worker/data.js').create_data_resolver>} args */
		(...args) => args
	);
	const create_request_classifier = vi.fn(
		/** @param {Parameters<typeof import('../../runtime/app/service-worker/requests.js').create_request_classifier>} args */
		(...args) => args
	);
	vm.runInNewContext(source.replace(/^import .*;$/gm, '').replace(/^export /gm, ''), {
		location: { origin },
		create_data_resolver,
		create_request_classifier,
		...bindings
	});
	expect(create_data_resolver).toHaveBeenCalledOnce();
	expect(create_request_classifier).toHaveBeenCalledOnce();
	return {
		resolver: create_data_resolver.mock.calls[0],
		classifier: create_request_classifier.mock.calls[0][0]
	};
}

test('disabled extensions generate an inert module without inspecting the routing graph', async () => {
	const setup = fixture({}, { experimental: { serviceWorkerFallbacks: false } });
	setup.manifest = new Proxy(
		/** @type {ManifestData} */ ({}),
		{
			get() {
				throw new Error('The disabled extension must not read the manifest');
			}
		}
	);
	const source = generate(setup);
	expect(source).not.toMatch(/^import /m);
	const module = vm.runInNewContext(
		source.replace(/^export /gm, '') + '\n({ classifyRequest, resolveData })'
	);
	expect(() => module.classifyRequest()).toThrow('experimental.serviceWorkerFallbacks');
	await expect(module.resolveData()).rejects.toThrow('experimental.serviceWorkerFallbacks');
});

test('keeps grouped layout ownership, reset layouts and empty error slots in server node order', () => {
	const setup = fixture({
		'src/routes/+layout.svelte': '',
		'src/routes/+layout.server.js': 'export const load = () => ({});',
		'src/routes/(app)/+layout.svelte': '',
		'src/routes/(app)/+layout.server.js': 'export const load = () => ({});',
		'src/routes/(app)/catalog/+layout.svelte': '',
		'src/routes/(app)/catalog/+layout.server.js':
			"export const load = () => ({}); export const trailingSlash = 'always';",
		'src/routes/(app)/catalog/[id=integer]/+page.svelte': '',
		'src/routes/(app)/catalog/[id=integer]/+page.server.js':
			"export const load = () => ({}); export const trailingSlash = 'never';",
		'src/routes/(app)/catalog/reset/+page@.svelte': '',
		'src/routes/(app)/catalog/reset/+page.server.js': 'export const load = () => ({});',
		'src/routes/(app)/catalog/errors/+error.svelte': '',
		'src/routes/(app)/catalog/errors/deep/+page.svelte': '',
		'src/routes/api/+server.js': 'export const GET = () => new Response();'
	});
	const { resolver } = evaluate(generate(setup));
	const [routes] = resolver;
	expect(routes.map((route) => route.id).sort()).toEqual([
		'/(app)/catalog/[id=integer]',
		'/(app)/catalog/errors/deep',
		'/(app)/catalog/reset',
		'/api'
	]);
	const typed = /** @type {FallbackRoute} */ (
		routes.find((route) => route.id === '/(app)/catalog/[id=integer]')
	);
	expect(typed.nodes).toEqual([
		{ id: '/', kind: 'layout', server: true },
		{ id: '/(app)', kind: 'layout', server: true },
		{ id: '/(app)/catalog', kind: 'layout', server: true, slash: 'always' },
		{ id: '/(app)/catalog/[id=integer]', kind: 'page', server: true, slash: 'never' }
	]);
	expect(typed.pattern.test('/catalog/42')).toBe(true);
	expect(typed.pattern.test('/(app)/catalog/42')).toBe(false);
	expect(typed.params).toEqual([
		{ name: 'id', matcher: 'integer', optional: false, rest: false, chained: false }
	]);
	expect(routes.find((route) => route.id.endsWith('/reset'))?.nodes).toEqual([
		{ id: '/', kind: 'layout', server: true },
		{ id: '/(app)/catalog/reset', kind: 'page', server: true }
	]);
	expect(routes.find((route) => route.id.endsWith('/deep'))?.nodes).toEqual([
		{ id: '/', kind: 'layout', server: true },
		{ id: '/(app)', kind: 'layout', server: true },
		{ id: '/(app)/catalog', kind: 'layout', server: true, slash: 'always' },
		null,
		{ id: '/(app)/catalog/errors/deep', kind: 'page', server: false, slash: 'always' }
	]);
});

test('retains ownership of the implicit root layout and distinguishes universal loads', () => {
	const { resolver } = evaluate(
		generate(
			fixture({
				'src/routes/+page.svelte': '',
				'src/routes/+page.js': 'export const load = () => ({});'
			})
		)
	);
	expect(resolver[0][0].nodes).toEqual([
		{ id: '/', kind: 'layout', server: false },
		{ id: '/', kind: 'page', server: false }
	]);
	expect(resolver[1]).toEqual({});
	expect(resolver[2]).toEqual({});
});

test('does not route endpoint data requests to a lower-precedence dynamic page fallback', async () => {
	const { resolver } = evaluate(
		generate(
			fixture({
				'src/routes/feed/+server.js': 'export const GET = () => new Response();',
				'src/routes/[slug]/+page.server.js': 'export const load = () => ({});'
			})
		)
	);
	const resolve = create_data_resolver(...resolver);
	const page = vi.fn(() => ({ source: 'dynamic page fallback' }));
	const handlers = { '/[slug]': { page } };

	await expect(
		resolve(new Request(`${origin}/app/feed/__data.json`), handlers)
	).resolves.toBeNull();
	expect(page).not.toHaveBeenCalled();

	const response = await resolve(new Request(`${origin}/app/article/__data.json`), handlers);
	expect(response?.status).toBe(200);
	expect(await response?.text()).toContain('dynamic page fallback');
	expect(page).toHaveBeenCalledOnce();
});

test('declines runtime page options and inherited unknown options while preserving layout resets', () => {
	const setup = fixture({
		'src/routes/+page.svelte': '',
		'src/routes/direct/+page.svelte': '',
		'src/routes/direct/+page.server.js': 'export const trailingSlash = process.env.TRAILING_SLASH;',
		'src/routes/(dynamic)/+layout.server.js':
			'export { trailingSlash } from "./server-only-policy.js";',
		'src/routes/(dynamic)/inherited/+page.svelte': '',
		'src/routes/(dynamic)/override/+page.svelte': '',
		'src/routes/(dynamic)/override/+page.js': "export const trailingSlash = 'never';",
		'src/routes/(dynamic)/reset/+page@.svelte': ''
	});
	const { resolver } = evaluate(generate(setup));
	expect(
		resolver[0]
			.filter((route) => !route.unsupported)
			.map((route) => route.id)
			.sort()
	).toEqual(['/', '/(dynamic)/reset']);
	expect(
		resolver[0]
			.filter((route) => route.unsupported)
			.map((route) => route.id)
			.sort()
	).toEqual(['/(dynamic)/inherited', '/(dynamic)/override', '/direct']);
});

test('imports only worker-safe runtime, universal hooks and params from their real paths', () => {
	const setup = fixture({
		'src/routes/+page.svelte': '',
		'src/routes/+page.js': 'throw new Error("Do not import universal loads");',
		'src/routes/+page.server.js': 'import "server-only-secret"; export const load = () => ({});',
		'src/routes/+layout.server.js': 'import "server-only-secret";',
		'src/routes/api/+server.js': 'import "server-only-secret";',
		'src/hooks.server.js': 'import "server-only-secret";',
		'src/hooks.client.js': 'throw new Error("Do not import client hooks");',
		'src/hooks.js': 'export const transport = {};',
		'src/params.js': 'export const params = {};'
	});
	const source = generate(setup);
	const imports = [...source.matchAll(/^import .* from (".*");$/gm)].map((match) =>
		path.resolve(setup.output, JSON.parse(match[1]))
	);
	expect(imports).toEqual([
		path.join(runtime_directory, 'app/service-worker/data.js'),
		path.join(runtime_directory, 'app/service-worker/requests.js'),
		path.join(setup.root, 'src/hooks.js'),
		path.join(setup.root, 'src/params.js')
	]);
	const hooks = { transport: {} };
	const params = { integer: {} };
	const { resolver } = evaluate(source, { hooks, params });
	expect(resolver[1]).toBe(hooks);
	expect(resolver[2]).toBe(params);
});

test.each(/** @type {const} */ (['split', 'single', 'inline']))(
	'passes the deployment identity and the correct version check mode for %s bundles',
	(bundleStrategy) => {
		const { resolver, classifier } = evaluate(
			generate(fixture({}, { output: { bundleStrategy } }))
		);
		expect(resolver[3]).toEqual({
			base: '/app',
			version: 'deployment-A',
			versionCheck: bundleStrategy !== 'inline',
			origin
		});
		expect(classifier).toEqual({ origin, base: '/app', appDir: '_custom' });
	}
);
