/** @import { ManifestData, PageNode, ValidatedConfig } from 'types' */
import path from 'node:path';
import { runtime_directory } from '../utils.js';
import { posixify } from '../../utils/os.js';
import { s } from '../../utils/misc.js';
import { write_if_changed } from './utils.js';

/**
 * Keep the routing graph inside Kit. No server module is imported into the worker.
 * @param {ValidatedConfig} config
 * @param {ManifestData} manifest
 * @param {string} output
 * @param {string} root
 */
export function write_service_worker_data(config, manifest, output, root) {
	if (!config.experimental.serviceWorkerFallbacks) {
		write_if_changed(
			`${output}/service-worker-data.js`,
			`export function classifyRequest() { throw new Error('Enable experimental.serviceWorkerFallbacks to use offline extensions'); }\nexport async function resolveData() { classifyRequest(); }`
		);
		return;
	}

	/** @type {Map<PageNode, { id: string; kind: 'layout' | 'page' }>} */
	const owners = new Map();
	for (const route of manifest.routes) {
		if (route.layout) owners.set(route.layout, { id: route.id, kind: 'layout' });
		if (route.leaf) owners.set(route.leaf, { id: route.id, kind: 'page' });
	}
	const routes = manifest.routes
		.filter((route) => route.page || route.endpoint)
		.map((route) => {
			const page = route.page;
			const indices = page ? [...page.layouts, page.leaf] : [];
			// Endpoint-only routes and pages with dynamic options retain their precedence
			// even though the worker cannot answer their data requests.
			const unsupported =
				!page ||
				indices.some((index) => index !== undefined && manifest.nodes[index].page_options === null);
			const nodes = indices.map((index) => {
				if (index === undefined) return null;
				const node = manifest.nodes[index];
				return {
					...owners.get(node),
					server: !!node.server,
					slash: node.page_options?.trailingSlash
				};
			});
			return `{ id: ${s(route.id)}, pattern: ${route.pattern}, params: ${s(route.params)}, nodes: ${s(nodes)}${unsupported ? ', unsupported: true' : ''} }`;
		});
	/** @param {string} file */
	const relative = (file) => './' + posixify(path.relative(output, path.resolve(root, file)));
	const hooks = manifest.hooks.universal;
	const params = manifest.params;
	write_if_changed(
		`${output}/service-worker-data.js`,
		[
			`import { create_data_resolver } from ${s(`${runtime_directory}/app/service-worker/data.js`)};`,
			`import { create_request_classifier } from ${s(`${runtime_directory}/app/service-worker/requests.js`)};`,
			`export const classifyRequest = create_request_classifier({ origin: globalThis.location.origin, base: ${s(config.paths.base)}, appDir: ${s(config.appDir)} });`,
			hooks ? `import * as hooks from ${s(relative(hooks))};` : 'const hooks = {};',
			params ? `import { params } from ${s(relative(params))};` : 'const params = {};',
			`export const resolveData = create_data_resolver([${routes.join(',\n')}], hooks, params, {`,
			`base: ${s(config.paths.base)}, version: ${s(config.version.name)},`,
			`versionCheck: ${config.output.bundleStrategy !== 'inline'}, origin: globalThis.location.origin`,
			`});`
		].join('\n')
	);
}
