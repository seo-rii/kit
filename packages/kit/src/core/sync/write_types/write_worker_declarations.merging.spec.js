import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';
import { validate_config } from '../../config/index.js';
import create_manifest_data from '../create_manifest_data/index.js';
import { ts } from '../ts.js';
import { worker_declaration, write_worker_declarations } from './write_worker_declarations.js';

test('retains shared references across ambient module fragments', { timeout: 60000 }, () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-worker-ambient-references-'));
	const write = (/** @type {string} */ name, /** @type {string} */ content) => {
		const file = path.join(root, name);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, content);
		return file;
	};
	try {
		const config = validate_config({ kit: { experimental: { serviceWorkerFallbacks: true } } });
		config.kit.files.routes = path.join(root, 'src/routes');
		config.kit.outDir = path.join(root, '.svelte-kit');
		write('package.json', JSON.stringify({ type: 'module' }));
		write(
			'.svelte-kit/tsconfig.worker.json',
			JSON.stringify({
				compilerOptions: { module: 'NodeNext', moduleResolution: 'NodeNext', types: [] }
			})
		);
		write(
			'node_modules/worker-contract/package.json',
			JSON.stringify({ name: 'worker-contract', type: 'module', types: 'index.d.ts' })
		);
		const first = write(
			'node_modules/worker-contract/index.d.ts',
			`/// <reference lib="webworker" />
			/// <reference path="./globals.d.ts" />
			/// <reference path="./extra/index.d.ts" />
			declare module 'worker-contract' { export interface Payload { path: PathPayload; } }`
		);
		const second = write(
			'node_modules/worker-contract/extra/index.d.ts',
			`/// <reference types="shared-globals" />
			declare module 'worker-contract' { export interface Payload { types: TypePayload; } }`
		);
		const path_reference = write(
			'node_modules/worker-contract/globals.d.ts',
			`interface PathPayload { kind: 'path'; }`
		);
		write(
			'node_modules/worker-contract/extra/node_modules/@types/shared-globals/package.json',
			JSON.stringify({ name: '@types/shared-globals', types: 'index.d.ts' })
		);
		const type_reference = write(
			'node_modules/worker-contract/extra/node_modules/@types/shared-globals/index.d.ts',
			`interface TypePayload { kind: 'types'; }`
		);
		write('src/routes/+page.svelte', '<p>worker</p>');
		const worker = write(
			'src/routes/+page.worker.ts',
			`import type { Payload } from 'worker-contract';
			export const load = (): Payload => ({ path: { kind: 'path' }, types: { kind: 'types' } });`
		);
		/** @type {import('typescript').CompilerOptions} */
		const options = {
			module: ts.ModuleKind.NodeNext,
			moduleResolution: ts.ModuleResolutionKind.NodeNext,
			target: ts.ScriptTarget.ESNext,
			types: [],
			strict: true,
			skipLibCheck: false,
			noEmit: true
		};
		/** @param {import('typescript').Program} program */
		const diagnostics = (program) =>
			ts.getPreEmitDiagnostics(program).map((diagnostic) => ({
				code: diagnostic.code,
				message: ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')
			}));
		expect(
			diagnostics(
				ts.createProgram([worker], { ...options, lib: ['lib.esnext.d.ts', 'lib.webworker.d.ts'] })
			)
		).toEqual([]);
		fs.mkdirSync(path.join(config.kit.outDir, 'types'), { recursive: true });
		write_worker_declarations(config, create_manifest_data({ config, cwd: root }), root);
		const relative = path
			.relative(root, worker_declaration(config, worker, root))
			.split(path.sep)
			.join('/')
			.replace(/\.d\.ts$/, '.js');
		const app = write(
			'app.ts',
			`import type { load } from './${relative}';
			declare const data: ReturnType<typeof load>;
			const path: 'path' = data.path.kind;
			const types: 'types' = data.types.kind;
			// @ts-expect-error referenced declarations must retain their specific types
			const wrong_path: number = data.path.kind;
			// @ts-expect-error references from later fragments must also be retained
			const wrong_types: number = data.types.kind;
			// @ts-expect-error isolated declarations must not expose worker globals
			importScripts('worker.js');`
		);
		const program = ts.createProgram([app], {
			...options,
			lib: ['lib.esnext.d.ts', 'lib.dom.d.ts']
		});
		expect(diagnostics(program)).toEqual([]);
		for (const file of [worker, first, second]) expect(program.getSourceFile(file)).toBeUndefined();
		for (const file of [path_reference, type_reference])
			expect(program.getSourceFile(file)).toBeDefined();
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test(
	'keeps wildcard augmentations separate while preserving shared brands',
	{ timeout: 60000 },
	() => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-worker-wildcard-augmentations-'));
		const write = (/** @type {string} */ name, /** @type {string} */ content) => {
			const file = path.join(root, name);
			fs.mkdirSync(path.dirname(file), { recursive: true });
			fs.writeFileSync(file, content);
			return file;
		};
		try {
			const config = validate_config({ kit: { experimental: { serviceWorkerFallbacks: true } } });
			config.kit.files.routes = path.join(root, 'src/routes');
			config.kit.outDir = path.join(root, '.svelte-kit');
			write('package.json', JSON.stringify({ type: 'module' }));
			write(
				'.svelte-kit/tsconfig.worker.json',
				JSON.stringify({
					compilerOptions: { module: 'NodeNext', moduleResolution: 'NodeNext', types: [] }
				})
			);
			write(
				'node_modules/worker-contract/package.json',
				JSON.stringify({ name: 'worker-contract', type: 'module', types: 'index.d.ts' })
			);
			const contract = write(
				'node_modules/worker-contract/index.d.ts',
				`/// <reference lib="webworker" />
			declare module '*.worker-data' {
				import type { Shared } from 'worker-model';
				export interface Data { kind: 'base'; shared: Shared; }
				export class Model { private brand: unknown; }
				export const token: unique symbol;
				export type Token = typeof token;
			}
			declare module 'worker-contract' {
				import type * as First from 'one.worker-data';
				import type * as Second from 'two.worker-data';
				export interface Payload {
					first: First.Data; second: Second.Data;
					first_model: First.Model; second_model: Second.Model;
					first_token: First.Token; second_token: Second.Token;
				}
			}`
			);
			write(
				'node_modules/worker-contract/node_modules/worker-model/package.json',
				JSON.stringify({ name: 'worker-model', type: 'module', types: 'index.d.mts' })
			);
			const shared = write(
				'node_modules/worker-contract/node_modules/worker-model/index.d.mts',
				`export declare class Shared { private brand: unknown; }`
			);
			const augmentation = write(
				'src/augmentation.d.ts',
				`import 'one.worker-data';
			declare module 'one.worker-data' { interface Data { extra: 'one'; } }`
			);
			write('src/routes/+page.svelte', '<p>worker</p>');
			const assertions = `
			const first: 'one' = data.first.extra;
			// @ts-expect-error the second concrete module is not augmented
			data.second.extra;
			const first_model: typeof data.first_model = data.second_model;
			const second_model: typeof data.second_model = data.first_model;
			const first_token: typeof data.first_token = data.second_token;
			const second_token: typeof data.second_token = data.first_token;`;
			const worker = write(
				'src/routes/+page.worker.ts',
				`import type { Payload } from 'worker-contract';
			import '../augmentation.js';
			export const load = (): Payload => ({
				first: { kind: 'base', shared: null!, extra: 'one' }, second: { kind: 'base', shared: null! },
				first_model: null!, second_model: null!, first_token: null!, second_token: null!
			});
			declare const data: Payload;
			${assertions}`
			);
			/** @type {import('typescript').CompilerOptions} */
			const options = {
				module: ts.ModuleKind.NodeNext,
				moduleResolution: ts.ModuleResolutionKind.NodeNext,
				target: ts.ScriptTarget.ESNext,
				types: [],
				strict: true,
				skipLibCheck: false,
				noEmit: true
			};
			/** @param {import('typescript').Program} program */
			const diagnostics = (program) =>
				ts.getPreEmitDiagnostics(program).map((diagnostic) => ({
					code: diagnostic.code,
					message: ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')
				}));
			expect(
				diagnostics(
					ts.createProgram([worker], { ...options, lib: ['lib.esnext.d.ts', 'lib.webworker.d.ts'] })
				)
			).toEqual([]);
			fs.mkdirSync(path.join(config.kit.outDir, 'types'), { recursive: true });
			write_worker_declarations(config, create_manifest_data({ config, cwd: root }), root);
			const relative = path
				.relative(root, worker_declaration(config, worker, root))
				.split(path.sep)
				.join('/')
				.replace(/\.d\.ts$/, '.js');
			const app_pattern = write(
				'app-pattern.d.ts',
				`declare module '*.worker-data' { export interface Data { kind: 'app'; } }`
			);
			const app = write(
				'app.ts',
				`import type { load } from './${relative}';
			import type { Shared } from './node_modules/worker-contract/node_modules/worker-model/index.mjs';
			import type { Data as AppData } from 'one.worker-data';
			declare const app: AppData;
			const app_kind: 'app' = app.kind;
			// @ts-expect-error worker augmentations must not affect application modules
			app.extra;
			declare const data: ReturnType<typeof load>;
			${assertions}
			const shared_first: Shared = data.first.shared;
			const shared_second: Shared = data.second.shared;
			// @ts-expect-error isolated declarations must not expose worker globals
			importScripts('worker.js');`
			);
			const program = ts.createProgram([app, app_pattern], {
				...options,
				lib: ['lib.esnext.d.ts', 'lib.dom.d.ts']
			});
			expect(diagnostics(program)).toEqual([]);
			for (const file of [worker, contract, augmentation])
				expect(program.getSourceFile(file)).toBeUndefined();
			expect(program.getSourceFile(shared)).toBeDefined();
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	}
);

test('resolves wildcard ambient modules with TypeScript precedence', { timeout: 60000 }, () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-worker-wildcards-'));
	const write = (/** @type {string} */ name, /** @type {string} */ content) => {
		const file = path.join(root, name);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, content);
		return file;
	};
	try {
		const config = validate_config({ kit: { experimental: { serviceWorkerFallbacks: true } } });
		config.kit.files.routes = path.join(root, 'src/routes');
		config.kit.outDir = path.join(root, '.svelte-kit');
		write('package.json', JSON.stringify({ type: 'module' }));
		write(
			'.svelte-kit/tsconfig.worker.json',
			JSON.stringify({
				compilerOptions: { module: 'NodeNext', moduleResolution: 'NodeNext', types: [] }
			})
		);
		write(
			'node_modules/worker-contract/package.json',
			JSON.stringify({ name: 'worker-contract', type: 'module', types: 'index.d.ts' })
		);
		const contract = write(
			'node_modules/worker-contract/index.d.ts',
			`/// <reference lib="webworker" />
			declare module '*.worker-data' { export interface Data { kind: 'broad'; } }
			declare module '*' { export interface Data { kind: 'fallback'; } }
			declare module 'special*.worker-data' { export interface Data { kind: 'specific'; } }
			declare module 'same*.worker-data' { export interface Data { kind: 'first'; } }
			declare module 'same*-named.worker-data' { export interface Data { kind: 'second'; } }
			declare module 'special-exact.worker-data' { export interface Data { kind: 'exact'; } }
			declare module 'abc*bc' { export interface Data { kind: 'overlap'; } }
			declare module 'worker-contract' {
				import type { Data as Broad } from 'schema.worker-data';
				import type { Data as Specific } from 'special-schema.worker-data';
				import type { Data as Exact } from 'special-exact.worker-data';
				import type { Data as Physical } from 'physical.worker-data';
				import type { Data as Tied } from 'same-named.worker-data';
				import type { Data as Fallback } from 'abc';
				export interface Payload {
					broad: Broad; specific: Specific; exact: Exact;
					physical: Physical; tied: Tied; fallback: Fallback;
				}
			}`
		);
		write(
			'node_modules/physical.worker-data/package.json',
			JSON.stringify({ name: 'physical.worker-data', type: 'module', types: 'index.d.ts' })
		);
		const physical = write(
			'node_modules/physical.worker-data/index.d.ts',
			`export interface Data { kind: 'physical'; }`
		);
		write('src/routes/+page.svelte', '<p>worker</p>');
		const worker = write(
			'src/routes/+page.worker.ts',
			`import type { Payload } from 'worker-contract';
			export const load = (): Payload => ({
				broad: { kind: 'broad' }, specific: { kind: 'specific' }, exact: { kind: 'exact' },
				physical: { kind: 'physical' }, tied: { kind: 'first' }, fallback: { kind: 'fallback' }
			});`
		);
		/** @type {import('typescript').CompilerOptions} */
		const options = {
			module: ts.ModuleKind.NodeNext,
			moduleResolution: ts.ModuleResolutionKind.NodeNext,
			target: ts.ScriptTarget.ESNext,
			types: [],
			strict: true,
			skipLibCheck: false,
			noEmit: true
		};
		/** @param {import('typescript').Program} program */
		const diagnostics = (program) =>
			ts.getPreEmitDiagnostics(program).map((diagnostic) => ({
				code: diagnostic.code,
				message: ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')
			}));
		expect(
			diagnostics(
				ts.createProgram([worker], { ...options, lib: ['lib.esnext.d.ts', 'lib.webworker.d.ts'] })
			)
		).toEqual([]);
		fs.mkdirSync(path.join(config.kit.outDir, 'types'), { recursive: true });
		write_worker_declarations(config, create_manifest_data({ config, cwd: root }), root);
		const relative = path
			.relative(root, worker_declaration(config, worker, root))
			.split(path.sep)
			.join('/')
			.replace(/\.d\.ts$/, '.js');
		const app = write(
			'app.ts',
			`import type { load } from './${relative}';
			declare const data: ReturnType<typeof load>;
			const broad: 'broad' = data.broad.kind;
			const specific: 'specific' = data.specific.kind;
			const exact: 'exact' = data.exact.kind;
			const physical: 'physical' = data.physical.kind;
			const tied: 'first' = data.tied.kind;
			const fallback: 'fallback' = data.fallback.kind;
			// @ts-expect-error wildcard contracts must retain their specific types
			const wrong: number = data.broad.kind;
			// @ts-expect-error isolated declarations must not expose worker globals
			importScripts('worker.js');`
		);
		const program = ts.createProgram([app], {
			...options,
			lib: ['lib.esnext.d.ts', 'lib.dom.d.ts']
		});
		expect(diagnostics(program)).toEqual([]);
		for (const file of [worker, contract]) expect(program.getSourceFile(file)).toBeUndefined();
		expect(program.getSourceFile(physical)).toBeDefined();
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test(
	'preserves module augmentations of shared and isolated declarations',
	{ timeout: 60000 },
	() => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-worker-augmentations-'));
		const write = (/** @type {string} */ name, /** @type {string} */ content) => {
			const file = path.join(root, name);
			fs.mkdirSync(path.dirname(file), { recursive: true });
			fs.writeFileSync(file, content);
			return file;
		};
		try {
			const config = validate_config({ kit: { experimental: { serviceWorkerFallbacks: true } } });
			config.kit.files.routes = path.join(root, 'src/routes');
			config.kit.outDir = path.join(root, '.svelte-kit');
			write('package.json', JSON.stringify({ type: 'module' }));
			write(
				'.svelte-kit/tsconfig.worker.json',
				JSON.stringify({
					compilerOptions: { module: 'NodeNext', moduleResolution: 'NodeNext', types: [] }
				})
			);
			/** @type {string[]} */
			const isolated = [];
			for (const kind of ['shared', 'isolated']) {
				const directory = `node_modules/${kind}-contract`;
				write(
					`${directory}/package.json`,
					JSON.stringify({
						name: `${kind}-contract`,
						type: 'module',
						exports: { '.': './contract.d.ts', './augmentation': './augmentation.d.ts' }
					})
				);
				const contract = write(
					`${directory}/contract.d.ts`,
					`${kind === 'isolated' ? '/// <reference lib="webworker" />\n' : ''}export interface Payload { first: string; }`
				);
				if (kind === 'isolated') isolated.push(contract);
				isolated.push(
					write(
						`${directory}/augmentation.d.ts`,
						`/// <reference lib="webworker" />
					import './contract.js';
					declare module './contract.js' { interface Payload { second: number; } }`
					)
				);
			}
			write('src/routes/+page.svelte', '<p>worker</p>');
			const worker = write(
				'src/routes/+page.worker.ts',
				`import 'shared-contract/augmentation';
			import 'isolated-contract/augmentation';
			import type { Payload as Shared } from 'shared-contract';
			import type { Payload as Isolated } from 'isolated-contract';
			export const load = (): { shared: Shared; isolated: Isolated } => ({
				shared: { first: 'shared', second: 1 },
				isolated: { first: 'isolated', second: 2 }
			});`
			);
			/** @type {import('typescript').CompilerOptions} */
			const options = {
				module: ts.ModuleKind.NodeNext,
				moduleResolution: ts.ModuleResolutionKind.NodeNext,
				target: ts.ScriptTarget.ESNext,
				types: [],
				strict: true,
				skipLibCheck: false,
				noEmit: true
			};
			/** @param {import('typescript').Program} program */
			const diagnostics = (program) =>
				ts.getPreEmitDiagnostics(program).map((diagnostic) => ({
					code: diagnostic.code,
					message: ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')
				}));
			expect(
				diagnostics(
					ts.createProgram([worker], { ...options, lib: ['lib.esnext.d.ts', 'lib.webworker.d.ts'] })
				)
			).toEqual([]);
			const manifest = create_manifest_data({ config, cwd: root });
			fs.mkdirSync(path.join(config.kit.outDir, 'types'), { recursive: true });
			write_worker_declarations(config, manifest, root);
			const relative = path
				.relative(root, worker_declaration(config, worker, root))
				.split(path.sep)
				.join('/')
				.replace(/\.d\.ts$/, '.js');
			const app = write(
				'app.ts',
				`import type { load } from './${relative}';
			declare const data: ReturnType<typeof load>;
			const shared_first: string = data.shared.first;
			const shared_second: number = data.shared.second;
			const isolated_first: string = data.isolated.first;
			const isolated_second: number = data.isolated.second;
			// @ts-expect-error isolated declarations must not expose worker globals
			importScripts('worker.js');`
			);
			const program = ts.createProgram([app], {
				...options,
				lib: ['lib.esnext.d.ts', 'lib.dom.d.ts']
			});

			expect(diagnostics(program)).toEqual([]);
			for (const file of [worker, ...isolated]) expect(program.getSourceFile(file)).toBeUndefined();
			expect(
				program.getSourceFile(path.join(root, 'node_modules/shared-contract/contract.d.ts'))
			).toBeDefined();
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	}
);

test(
	'merges ambient module declarations across files without merging local imports',
	{ timeout: 60000 },
	() => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-worker-ambient-merges-'));
		const write = (/** @type {string} */ name, /** @type {string} */ content) => {
			const file = path.join(root, name);
			fs.mkdirSync(path.dirname(file), { recursive: true });
			fs.writeFileSync(file, content);
			return file;
		};
		try {
			const config = validate_config({ kit: { experimental: { serviceWorkerFallbacks: true } } });
			config.kit.files.routes = path.join(root, 'src/routes');
			config.kit.outDir = path.join(root, '.svelte-kit');
			write('package.json', JSON.stringify({ type: 'module' }));
			write(
				'.svelte-kit/tsconfig.worker.json',
				JSON.stringify({
					compilerOptions: { module: 'NodeNext', moduleResolution: 'NodeNext', types: [] }
				})
			);
			write(
				'node_modules/worker-contract/package.json',
				JSON.stringify({ name: 'worker-contract', type: 'module', types: 'index.d.ts' })
			);
			const first = write(
				'node_modules/worker-contract/index.d.ts',
				`
			/// <reference lib="webworker" />
			/// <reference path="./extra/index.d.ts" />
			declare module 'worker-contract' {
				import type Default from 'nested-value';
				import type { Value } from 'nested-value';
				import type * as Namespace from 'nested-value';
				import type Common = require('common-value');
				export { Value as First, Default };
				export interface Payload { first: Value; first_default: Default; first_namespace: Namespace.Value; first_common: Common.Value; }
			}
		`
			);
			const second = write(
				'node_modules/worker-contract/extra/index.d.ts',
				`
			declare module 'worker-contract' {
				import type Default from 'nested-value';
				import type { Value } from 'nested-value';
				import type * as Namespace from 'nested-value';
				import type Common = require('common-value');
				export { Value as Second };
				export interface Payload { second: Value; second_default: Default; second_namespace: Namespace.Value; second_common: Common.Value; }
			}
			declare module 'worker-contract' {
				export interface Payload { third: boolean; }
			}
		`
			);
			for (const [directory, literal] of [
				['', 'first'],
				['extra/', 'second']
			]) {
				const dependency = `node_modules/worker-contract/${directory}node_modules/nested-value`;
				write(
					`${dependency}/package.json`,
					JSON.stringify({ name: 'nested-value', type: 'module', types: 'index.d.ts' })
				);
				write(
					`${dependency}/index.d.ts`,
					`export interface Value { kind: '${literal}' } export default interface Default { kind: '${literal}' }`
				);
				const common = `node_modules/worker-contract/${directory}node_modules/common-value`;
				write(
					`${common}/package.json`,
					JSON.stringify({ name: 'common-value', type: 'commonjs', types: 'index.d.ts' })
				);
				write(
					`${common}/index.d.ts`,
					`declare namespace Common { interface Value { kind: '${literal}' } } export = Common;`
				);
			}
			write('src/routes/+page.svelte', '<p>worker</p>');
			const worker = write(
				'src/routes/+page.worker.ts',
				`
			import type { Payload, First, Second, Default } from 'worker-contract';
			export const load = (): { payload: Payload; first: First; second: Second; default: Default } => ({
				payload: { first: { kind: 'first' }, second: { kind: 'second' }, third: true,
					first_default: { kind: 'first' }, first_namespace: { kind: 'first' }, first_common: { kind: 'first' },
					second_default: { kind: 'second' }, second_namespace: { kind: 'second' }, second_common: { kind: 'second' } },
				first: { kind: 'first' }, second: { kind: 'second' }, default: { kind: 'first' }
			});
		`
			);
			/** @type {import('typescript').CompilerOptions} */
			const options = {
				module: ts.ModuleKind.NodeNext,
				moduleResolution: ts.ModuleResolutionKind.NodeNext,
				target: ts.ScriptTarget.ESNext,
				types: [],
				strict: true,
				skipLibCheck: false,
				noEmit: true
			};
			/** @param {import('typescript').Program} program */
			const diagnostics = (program) =>
				ts.getPreEmitDiagnostics(program).map((d) => ({
					code: d.code,
					message: ts.flattenDiagnosticMessageText(d.messageText, '\n')
				}));
			expect(
				diagnostics(
					ts.createProgram([worker], { ...options, lib: ['lib.esnext.d.ts', 'lib.webworker.d.ts'] })
				)
			).toEqual([]);
			fs.mkdirSync(path.join(config.kit.outDir, 'types'), { recursive: true });
			write_worker_declarations(config, create_manifest_data({ config, cwd: root }), root);
			const relative = path
				.relative(root, worker_declaration(config, worker, root))
				.split(path.sep)
				.join('/')
				.replace(/\.d\.ts$/, '.js');
			const app = write(
				'app.ts',
				`
			import type { load } from './${relative}';
			declare const data: ReturnType<typeof load>;
			const first: 'first' = data.payload.first.kind;
			const second: 'second' = data.payload.second.kind;
			const third: boolean = data.payload.third;
			const exported_first: 'first' = data.first.kind;
				const exported_default: 'first' = data.default.kind;
				const first_default: 'first' = data.payload.first_default.kind;
				const first_namespace: 'first' = data.payload.first_namespace.kind;
				const first_common: 'first' = data.payload.first_common.kind;
				const second_default: 'second' = data.payload.second_default.kind;
				const second_namespace: 'second' = data.payload.second_namespace.kind;
				const second_common: 'second' = data.payload.second_common.kind;
			const exported_second: 'second' = data.second.kind;
			// @ts-expect-error declarations must not expose worker globals
			importScripts('worker.js');
		`
			);
			const program = ts.createProgram([app], {
				...options,
				lib: ['lib.esnext.d.ts', 'lib.dom.d.ts']
			});
			expect(diagnostics(program)).toEqual([]);
			for (const file of [worker, first, second])
				expect(program.getSourceFile(file)).toBeUndefined();
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	}
);
