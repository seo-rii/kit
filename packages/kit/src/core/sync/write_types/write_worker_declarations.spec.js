import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';
import { validate_config } from '../../config/index.js';
import create_manifest_data from '../create_manifest_data/index.js';
import { ts } from '../ts.js';
import { write_app_types } from '../write_app_types.js';
import { write_env } from '../write_env.js';
import { write_tsconfig } from '../write_tsconfig/index.js';
import { write_all_types, write_types } from './index.js';
import { is_worker_type_dependency } from './write_worker_declarations.js';

/** @param {string} file */
function program(file) {
	const parsed = ts.getParsedCommandLineOfConfigFile(
		file,
		{},
		{
			...ts.sys,
			onUnRecoverableConfigFileDiagnostic: () => {}
		}
	);
	if (!parsed) throw new Error('Unable to parse test project');
	return ts.createProgram(parsed.fileNames, parsed.options);
}

/** @param {import('typescript').Program} program */
function diagnostics(program) {
	return ts.getPreEmitDiagnostics(program).map((diagnostic) => ({
		file: diagnostic.file?.fileName,
		code: diagnostic.code,
		message: ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')
	}));
}

test.each([
	['js', true],
	['ts', true],
	['js', false],
	['ts', false]
])(
	'keeps inferred %s worker data and actions across the app declaration boundary (annotated: %s)',
	{ timeout: 60000 },
	(extension, annotated) => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-worker-declarations-'));
		const write = (/** @type {string} */ name, /** @type {string} */ content) => {
			const file = path.join(root, name);
			fs.mkdirSync(path.dirname(file), { recursive: true });
			fs.writeFileSync(file, content);
			return file;
		};
		try {
			const config = validate_config({
				kit: { experimental: { serviceWorkerFallbacks: true } }
			});
			config.kit.outDir = path.join(root, '.svelte-kit');
			for (const name of /** @type {const} */ ([
				'src',
				'routes',
				'assets',
				'params',
				'serviceWorker'
			])) {
				config.kit.files[name] = path.join(root, name === 'src' ? 'src' : `src/${name}`);
			}
			config.kit.alias.$lib = path.join(root, 'src/lib');
			fs.mkdirSync(path.join(root, 'node_modules/@sveltejs'), { recursive: true });
			fs.symlinkSync(
				path.resolve(import.meta.dirname, '../../../..'),
				path.join(root, 'node_modules/@sveltejs/kit'),
				'dir'
			);
			write(
				'tsconfig.json',
				JSON.stringify({
					extends: '$app/tsconfig',
					compilerOptions: {
						strict: true,
						strictNullChecks: annotated,
						exactOptionalPropertyTypes: annotated,
						noUncheckedIndexedAccess: true
					},
					include: ['src/app.ts', 'src/routes/+page.server.ts']
				})
			);
			write('src/routes/+page.svelte', '<p>worker</p>');
			const payload_declaration = `
				/// <reference path="./metadata.d.ts" />
				import type { Metadata } from './metadata.js';
				export interface Payload extends Metadata { scope: string; count: number }
			`;
			write('src/lib/payload.d.ts', payload_declaration);
			write('src/lib/metadata.d.ts', 'export interface Metadata { version: number }');
			write(
				'node_modules/worker-helper/package.json',
				JSON.stringify({ name: 'worker-helper', types: 'index.d.ts' })
			);
			write(
				'node_modules/worker-helper/index.d.ts',
				"export { package_payload, type PackagePayload } from './implementation.js';"
			);
			const package_source = write(
				'node_modules/worker-helper/implementation.ts',
				`
				export interface PackagePayload { scope: string }
				export const package_payload = (): PackagePayload => ({ scope: (globalThis as unknown as ServiceWorkerGlobalScope).registration.scope });
			`
			);
			const nominal = `
				declare const token: unique symbol;
				export type Brand = string & { readonly [token]: true };
				export declare class Model { private identity; value: number; }
				export declare function model(): Model;
				export declare function brand(): Brand;
			`;
			write('src/lib/model.d.ts', nominal);
			write(
				'node_modules/nominal-worker-lib/package.json',
				JSON.stringify({ name: 'nominal-worker-lib', types: 'index.d.ts' })
			);
			write('node_modules/nominal-worker-lib/index.d.ts', nominal);
			const shared_model = `
				declare const token: unique symbol;
				export type Brand = string & { readonly [token]: true };
				export class Model { private identity = 1; value = 2; }
				export const model = () => new Model();
				export const brand = (value: unknown): Brand => String(new URL(String(value), 'https://example.com')).toLowerCase() as Brand;
				export const async_brand = () => Promise.resolve(brand('/'));
				export const nullable_brand = () => Math.random() > 0.5 ? brand('/') : null;
				export const first_brand = () => [brand('/')][0];
			`;
			const local_shared_source = write('src/lib/shared-model.ts', shared_model);
			write(
				'node_modules/shared-ts-lib/package.json',
				JSON.stringify({ name: 'shared-ts-lib', types: 'index.ts' })
			);
			const external_shared_source = write('node_modules/shared-ts-lib/index.ts', shared_model);
			const worker_only = write(
				'src/lib/worker-only.ts',
				`
				import { brand } from './shared-model.js';
				export function worker_brand() { self.importScripts('setup.js'); return brand('/'); }
			`
			);
			const worker_globals = write(
				'src/lib/worker-globals.ts',
				'export const worker_navigator = () => self.navigator;'
			);
			const worker_options = write(
				'src/lib/worker-options.ts',
				'export const options: { value?: string } = { value: undefined };'
			);
			const dynamic_wrapper = write(
				'src/lib/dynamic-wrapper.ts',
				`
				export interface Payload { value: string }
				export async function dynamic_payload(): Promise<Payload> {
					await import('./worker-only.js');
					return { value: 'worker' };
				}
			`
			);
			const jsdoc_dependency = write(
				'src/lib/jsdoc-worker.ts',
				"importScripts('setup.js'); export interface Data { count: number }"
			);
			const jsdoc_wrapper = write(
				'src/lib/jsdoc-wrapper.js',
				`
				/** @import { Data } from './jsdoc-worker.js' */
				/** @typedef {{ nested: Data }} Payload */
				/** @returns {Payload} */
				export function jsdoc_payload() { return { nested: { count: 1 } }; }
			`
			);
			write(
				'node_modules/referenced-worker-lib/package.json',
				JSON.stringify({ name: 'referenced-worker-lib', types: 'index.d.ts' })
			);
			const referenced_package = write(
				'node_modules/referenced-worker-lib/index.d.ts',
				`
				/// <reference types="worker-reference" />
				export interface Payload { count: number }
				export declare function referenced_payload(): Payload;
			`
			);
			write(
				'node_modules/@types/worker-reference/package.json',
				JSON.stringify({ name: '@types/worker-reference', types: 'index.d.ts' })
			);
			const referenced_globals = write(
				'node_modules/@types/worker-reference/index.d.ts',
				'/// <reference lib="webworker" />\nexport interface Marker {}'
			);
			write(
				'node_modules/conditional-worker-lib/package.json',
				JSON.stringify({
					name: 'conditional-worker-lib',
					type: 'module',
					exports: {
						'.': { import: './import.d.ts', require: './require.d.ts' }
					}
				})
			);
			write(
				'node_modules/conditional-worker-lib/import.d.ts',
				"export interface Payload { kind: 'import' }"
			);
			const required_package = write(
				'node_modules/conditional-worker-lib/require.d.ts',
				'/// <reference lib="webworker" />\nexport interface Payload { kind: "require" }'
			);
			const conditional_declaration = write(
				'src/lib/conditional.d.ts',
				`
				import type { Payload as Imported } from 'conditional-worker-lib';
				import type { Payload as Required } from 'conditional-worker-lib' with { 'resolution-mode': 'require' };
				export interface Conditional { imported: Imported; required: Required }
				export declare function conditional(): Conditional;
				`
			);
			write(
				'node_modules/ambient-worker-lib/package.json',
				JSON.stringify({ name: 'ambient-worker-lib', types: 'index.d.ts' })
			);
			write(
				'node_modules/ambient-worker-lib/index.d.ts',
				`
				declare module 'ambient-worker-lib' {
					export interface Payload { nested: import('worker-helper').PackagePayload }
					export function ambient_payload(): Payload;
				}
				declare module 'ambient-worker-lib' {
					export interface Payload { count: number }
				}
			`
			);
			write(
				'src/lib/scope.ts',
				`
				/// <reference lib="webworker" />
				export function scope() { return (globalThis as unknown as ServiceWorkerGlobalScope).registration.scope; }
			`
			);
			const helper = write(
				'src/lib/helper.js',
				`
				import { scope } from './scope.js';
				/** @returns {import('./payload.js').Payload} */
				export function payload() {
					const worker = /** @type {ServiceWorkerGlobalScope} */ (/** @type {unknown} */ (globalThis));
					return { scope: worker.registration.scope + scope(), count: 1, version: 1 };
				}
			`
			);
			const worker = write(
				`src/routes/+page.worker.${extension}`,
				`
				import { payload } from '$lib/helper.js';
				import { package_payload } from 'worker-helper';
				import { model as local_model, brand as local_brand } from '$lib/model.js';
				import { model as external_model, brand as external_brand } from 'nominal-worker-lib';
				import { referenced_payload } from 'referenced-worker-lib';
				import { conditional } from '$lib/conditional.js';
				import { model as shared_local_model, async_brand as shared_local_brand, nullable_brand, first_brand } from '$lib/shared-model.js';
				import { model as shared_external_model, async_brand as shared_external_brand } from 'shared-ts-lib';
				import { worker_brand } from '$lib/worker-only.js';
				import { worker_navigator } from '$lib/worker-globals.js';
				import { options } from '$lib/worker-options.js';
				import { dynamic_payload } from '$lib/dynamic-wrapper.js';
				import { jsdoc_payload } from '$lib/jsdoc-wrapper.js';
				import { ambient_payload } from 'ambient-worker-lib';
				${annotated && extension === 'ts' ? "import type { PageWorkerLoad, PageWorkerActions } from './$worker-types';" : ''}
				${annotated && extension === 'js' ? "/** @type {import('./$worker-types').PageWorkerLoad} */" : ''}
				export const load${annotated && extension === 'ts' ? ': PageWorkerLoad' : ''} = async (${annotated ? '{ url }' : ''}) => ({ payload: payload(), package_payload: package_payload(), local_model: local_model(), local_brand: local_brand(), external_model: external_model(), external_brand: external_brand(), shared_local_model: shared_local_model(), shared_local_brand: await shared_local_brand(), shared_external_model: shared_external_model(), shared_external_brand: await shared_external_brand(), nullable_brand: nullable_brand(), first_brand: first_brand(), worker_brand: worker_brand(), online: worker_navigator().onLine, value: options.value, dynamic_payload: await dynamic_payload(), jsdoc_payload: jsdoc_payload(), ambient_payload: ambient_payload(), referenced_payload: referenced_payload(), conditional: conditional(), nullable: Math.random() > 0.5 ? 'value' : null, pathname: ${annotated ? 'url.pathname' : "'/'"} });
				${annotated && extension === 'js' ? "/** @type {import('./$worker-types').PageWorkerActions} */" : ''}
				export const actions${annotated && extension === 'ts' ? ': PageWorkerActions' : ''} = {
					default: () => (${annotated ? "{ type: 'success', status: 200, data: { saved: true, ...payload() } }" : '{ saved: true, ...payload() }'})
				};
			`
			);
			write(
				'src/routes/+page.server.ts',
				'export const load = () => ({ payload: { scope: "server", count: 2, version: 1 }, package_payload: { scope: "server" }, nullable: "server", pathname: "/" });'
			);
			const app = write(
				'src/app.ts',
				`
				import type { PageData, ActionData, PageWorkerData } from '../.svelte-kit/types/src/routes/$types';
				import type { Model as LocalModel, Brand as LocalBrand } from './lib/model.js';
				import type { Model as ExternalModel, Brand as ExternalBrand } from 'nominal-worker-lib';
				import type { Model as SharedLocalModel, Brand as SharedLocalBrand } from './lib/shared-model.js';
				import type { Model as SharedExternalModel, Brand as SharedExternalBrand } from 'shared-ts-lib';
				declare const worker_data: PageWorkerData;
				const local_model: LocalModel = worker_data.local_model;
				const local_brand: LocalBrand = worker_data.local_brand;
				const external_model: ExternalModel = worker_data.external_model;
				const external_brand: ExternalBrand = worker_data.external_brand;
				const shared_local_model: SharedLocalModel = worker_data.shared_local_model;
				const shared_local_brand: SharedLocalBrand = worker_data.shared_local_brand;
				const shared_external_model: SharedExternalModel = worker_data.shared_external_model;
				const shared_external_brand: SharedExternalBrand = worker_data.shared_external_brand;
				const worker_brand: SharedLocalBrand = worker_data.worker_brand;
				const nullable_brand: SharedLocalBrand | null = worker_data.nullable_brand;
				const first_brand: SharedLocalBrand = worker_data.first_brand;
				worker_data.dynamic_payload.value.toUpperCase();
				worker_data.jsdoc_payload.nested.count.toFixed();
				worker_data.referenced_payload.count.toFixed();
				const imported: 'import' = worker_data.conditional.imported.kind;
				const required: 'require' = worker_data.conditional.required.kind;
				// @ts-expect-error references must retain the package's actual payload type
				worker_data.referenced_payload.count.toUpperCase();
				worker_data.ambient_payload.nested.scope.toUpperCase();
				worker_data.ambient_payload.count.toFixed();
				// @ts-expect-error a materialized ambient module retains nested field types
				worker_data.ambient_payload.nested.scope.toFixed();
				declare const data: PageData;
				data.payload.scope.toUpperCase();
				data.payload.count.toFixed();
				data.payload.version.toFixed();
				data.package_payload.scope.toUpperCase();
				${annotated ? '// @ts-expect-error snapshots must preserve possible null values' : ''}
				data.nullable.toUpperCase();
				// @ts-expect-error worker data must retain its inferred number type
				data.payload.count.toUpperCase();
				declare const action: NonNullable<ActionData>;
				const saved: boolean = action.saved;
				// @ts-expect-error worker actions must retain their inferred boolean type
				const wrong: string = action.saved;
				document.querySelector('p');
				// @ts-expect-error the app must not acquire worker globals
				importScripts('worker.js');
			`
			);
			write_tsconfig(config.kit, root);
			const manifest = create_manifest_data({ config, cwd: root });
			write_app_types(config.kit, manifest, root);
			write_env('', {}, root);
			write_all_types(config, manifest, root);

			expect(diagnostics(program(path.join(config.kit.outDir, 'tsconfig.worker.json')))).toEqual(
				[]
			);
			let app_program = program(path.join(root, 'tsconfig.json'));
			expect(diagnostics(app_program)).toEqual([]);
			expect(app_program.getSourceFile(worker)).toBeUndefined();
			expect(app_program.getSourceFile(helper)).toBeUndefined();
			expect(app_program.getSourceFile(path.join(root, 'src/lib/scope.ts'))).toBeUndefined();
			expect(app_program.getSourceFile(package_source)).toBeUndefined();
			expect(app_program.getSourceFile(worker_only)).toBeUndefined();
			expect(app_program.getSourceFile(worker_globals)).toBeUndefined();
			if (annotated) expect(app_program.getSourceFile(worker_options)).toBeUndefined();
			expect(app_program.getSourceFile(dynamic_wrapper)).toBeUndefined();
			expect(app_program.getSourceFile(jsdoc_wrapper)).toBeUndefined();
			expect(app_program.getSourceFile(jsdoc_dependency)).toBeUndefined();
			expect(app_program.getSourceFile(local_shared_source)).toBeDefined();
			expect(app_program.getSourceFile(external_shared_source)).toBeDefined();
			expect(app_program.getSourceFile(referenced_package)).toBeUndefined();
			expect(app_program.getSourceFile(referenced_globals)).toBeUndefined();
			expect(app_program.getSourceFile(conditional_declaration)).toBeUndefined();
			expect(app_program.getSourceFile(required_package)).toBeUndefined();
			expect(
				app_program.getSourceFiles().some((file) => /lib\.webworker\.d\.ts$/.test(file.fileName))
			).toBe(false);
			expect(is_worker_type_dependency(root, helper)).toBe(true);
			expect(is_worker_type_dependency(root, path.join(root, 'src/lib/payload.d.ts'))).toBe(true);
			expect(is_worker_type_dependency(root, app)).toBe(false);
			// Dependency refresh behavior does not depend on load syntax or annotations.
			if (extension !== 'ts' || annotated) return;

			// A non-route dependency changing must update the inferred app contract too.
			write('src/lib/payload.d.ts', payload_declaration.replace('count: number', 'count: string'));
			write_types(config, manifest, path.join(root, 'src/lib/payload.d.ts'), root);
			app_program = program(path.join(root, 'tsconfig.json'));
			expect(diagnostics(app_program)).toEqual(
				expect.arrayContaining([expect.objectContaining({ file: app, code: 2339 })])
			);

			// Adding a previously unresolved helper outside routes also refreshes inference.
			fs.writeFileSync(
				worker,
				"import { added } from '$lib/new/helper.js'; export const load = () => ({ added: added() });"
			);
			write_types(config, manifest, worker, root);
			const added = write('src/lib/new/helper.ts', 'export const added = () => 42;');
			expect(is_worker_type_dependency(root, added)).toBe(true);
			write_types(config, manifest, added, root);
			write(
				'src/app.ts',
				`
				import type { PageWorkerData } from '../.svelte-kit/types/src/routes/$types';
				declare const data: PageWorkerData;
				data.added.toFixed();
				// @ts-expect-error the newly created helper must not leave stale any data
				data.added.toUpperCase();
			`
			);
			expect(diagnostics(program(path.join(root, 'tsconfig.json')))).toEqual([]);

			write(
				'src/worker-global.d.ts',
				'/// <reference lib="webworker" />\ninterface WorkerOnlyData { scope: ServiceWorkerGlobalScope }'
			);
			expect(() => write_all_types(config, manifest, root)).toThrow(
				'Cannot isolate global worker declaration'
			);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	}
);

test(
	'refreshes shared module eligibility when app compiler configuration changes',
	{ timeout: 60000 },
	() => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-worker-config-'));
		const write = (/** @type {string} */ name, /** @type {string} */ content) => {
			const file = path.join(root, name);
			fs.mkdirSync(path.dirname(file), { recursive: true });
			fs.writeFileSync(file, content);
			return file;
		};
		try {
			const config = validate_config({ kit: { experimental: { serviceWorkerFallbacks: true } } });
			config.kit.outDir = path.join(root, '.svelte-kit');
			for (const name of /** @type {const} */ ([
				'src',
				'routes',
				'assets',
				'params',
				'serviceWorker'
			])) {
				config.kit.files[name] = path.join(root, name === 'src' ? 'src' : `src/${name}`);
			}
			fs.mkdirSync(path.join(root, 'node_modules/@sveltejs'), { recursive: true });
			fs.symlinkSync(
				path.resolve(import.meta.dirname, '../../../..'),
				path.join(root, 'node_modules/@sveltejs/kit'),
				'dir'
			);
			const settings = write(
				'app-options.json',
				JSON.stringify({ compilerOptions: { lib: ['ESNext', 'DOM', 'DOM.Iterable'] } })
			);
			const app_config = {
				extends: ['$app/tsconfig', './app-options.json'],
				include: ['src/app.ts']
			};
			const jsconfig = write('jsconfig.json', JSON.stringify(app_config));
			const tsconfig = path.join(root, 'tsconfig.json');
			write('src/routes/+page.svelte', '<p>worker</p>');
			const shared = write(
				'src/shared.ts',
				`
			export interface Payload { value: string }
			export function payload(): Payload {
				Promise.withResolvers<string>();
				return { value: 'shared' };
			}
		`
			);
			write(
				'src/routes/+page.worker.ts',
				"import { payload } from '../shared.js'; export const load = () => ({ payload: payload() });"
			);
			write(
				'src/app.ts',
				`
			import type { PageWorkerData } from '../.svelte-kit/types/src/routes/$types';
			declare const data: PageWorkerData;
			data.payload.value.toUpperCase();
			// @ts-expect-error worker data stays typed when configuration changes
			data.payload.value.toFixed();
		`
			);
			write_tsconfig(config.kit, root);
			const manifest = create_manifest_data({ config, cwd: root });
			write_app_types(config.kit, manifest, root);
			write_env('', {}, root);
			write_all_types(config, manifest, root);
			let app = program(jsconfig);
			expect(diagnostics(app)).toEqual([]);
			expect(app.getSourceFile(shared)).toBeDefined();
			expect(is_worker_type_dependency(root, settings)).toBe(true);
			expect(is_worker_type_dependency(root, jsconfig)).toBe(true);
			expect(is_worker_type_dependency(root, tsconfig)).toBe(true);

			write(
				'app-options.json',
				JSON.stringify({ compilerOptions: { lib: ['ES2020', 'DOM', 'DOM.Iterable'] } })
			);
			write_types(config, manifest, settings, root);
			app = program(jsconfig);
			expect(diagnostics(app)).toEqual([]);
			expect(app.getSourceFile(shared)).toBeUndefined();

			// A newly added higher-priority config must replace the jsconfig decision too.
			write(
				'tsconfig.json',
				JSON.stringify({
					...app_config,
					compilerOptions: { lib: ['ESNext', 'DOM', 'DOM.Iterable'] }
				})
			);
			write_types(config, manifest, tsconfig, root);
			app = program(tsconfig);
			expect(diagnostics(app)).toEqual([]);
			expect(app.getSourceFile(shared)).toBeDefined();
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	}
);
