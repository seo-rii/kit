import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';
import { validate_config } from '../../config/index.js';
import create_manifest_data from '../create_manifest_data/index.js';
import { ts } from '../ts.js';
import { worker_declaration, write_worker_declarations } from './write_worker_declarations.js';

test.each(['module', 'commonjs'])(
	'preserves isolated dependency formats in a %s application',
	{ timeout: 60000 },
	(module_type) => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-worker-formats-'));
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
			write('package.json', JSON.stringify({ type: module_type }));
			write(
				'.svelte-kit/tsconfig.worker.json',
				JSON.stringify({
					compilerOptions: { module: 'NodeNext', moduleResolution: 'NodeNext', types: [] }
				})
			);
			write(
				'node_modules/shared-brand/package.json',
				JSON.stringify({ name: 'shared-brand', type: 'commonjs', types: 'index.d.ts' })
			);
			const shared = write(
				'node_modules/shared-brand/index.d.ts',
				'declare const token: unique symbol; export type Brand = string & { readonly [token]: true };'
			);
			const commonjs = `
				/// <reference lib="webworker" />
				declare namespace helper { interface Payload { value: import('shared-brand').Brand } }
				declare function helper(): helper.Payload;
				export = helper;
			`;
			const esm = `
				/// <reference lib="webworker" />
				export default class Payload { value: 'esm'; }
			`;
			const sources = [
				write('src/commonjs.d.cts', commonjs),
				write('src/esm.d.mts', esm),
				write('node_modules/commonjs-helper/index.d.ts', commonjs),
				write('node_modules/esm-helper/index.d.ts', esm)
			];
			for (const type of ['commonjs', 'module']) {
				const name = type === 'module' ? 'esm-helper' : 'commonjs-helper';
				write(
					`node_modules/${name}/package.json`,
					JSON.stringify({ name, type, types: 'index.d.ts' })
				);
			}
			write(
				'node_modules/ambient-commonjs/package.json',
				JSON.stringify({ name: 'ambient-commonjs', types: 'index.d.ts' })
			);
			sources.push(
				write(
					'node_modules/ambient-commonjs/index.d.ts',
					`
					/// <reference lib="webworker" />
					declare module 'ambient-commonjs' {
						function helper(): helper.Payload;
						namespace helper { interface Payload { value: import('shared-brand').Brand } }
						export = helper;
					}
				`
				)
			);
			write('src/routes/+page.svelte', '<p>worker</p>');
			const worker = write(
				'src/routes/+page.worker.ts',
				`
				import explicit_commonjs from '../commonjs.cjs';
				import implicit_commonjs from 'commonjs-helper';
				import ambient_commonjs from 'ambient-commonjs';
				import ExplicitEsm from '../esm.mjs';
				import ImplicitEsm from 'esm-helper';
				export const load = () => ({
					explicit_commonjs: explicit_commonjs(),
					implicit_commonjs: implicit_commonjs(),
					ambient_commonjs: ambient_commonjs(),
					explicit_esm: new ExplicitEsm(),
					implicit_esm: new ImplicitEsm()
				});
			`
			);
			const manifest = create_manifest_data({ config, cwd: root });
			fs.mkdirSync(path.join(config.kit.outDir, 'types'), { recursive: true });
			write_worker_declarations(config, manifest, root);
			const declaration = worker_declaration(config, worker, root);
			const relative = path
				.relative(root, declaration)
				.split(path.sep)
				.join('/')
				.replace(/\.d\.ts$/, '.js');
			const app = write(
				'app.ts',
				`
				import type { load } from './${relative}';
				import type { Brand } from 'shared-brand';
				declare const data: ReturnType<typeof load>;
				const explicit_commonjs: Brand = data.explicit_commonjs.value;
				const implicit_commonjs: Brand = data.implicit_commonjs.value;
				const ambient_commonjs: Brand = data.ambient_commonjs.value;
				const explicit_esm: 'esm' = data.explicit_esm.value;
				const implicit_esm: 'esm' = data.implicit_esm.value;
				// @ts-expect-error isolated declarations must not add worker globals
				importScripts('worker-only.js');
			`
			);
			const program = ts.createProgram([app], {
				module: ts.ModuleKind.NodeNext,
				moduleResolution: ts.ModuleResolutionKind.NodeNext,
				target: ts.ScriptTarget.ESNext,
				lib: ['lib.esnext.d.ts', 'lib.dom.d.ts'],
				types: [],
				strict: true,
				noEmit: true,
				skipLibCheck: false
			});
			expect(
				ts.getPreEmitDiagnostics(program).map((diagnostic) => ({
					file: diagnostic.file?.fileName,
					code: diagnostic.code,
					message: ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')
				}))
			).toEqual([]);
			for (const source of [...sources, worker])
				expect(program.getSourceFile(source)).toBeUndefined();
			expect(program.getSourceFile(shared)).toBeDefined();
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	}
);
