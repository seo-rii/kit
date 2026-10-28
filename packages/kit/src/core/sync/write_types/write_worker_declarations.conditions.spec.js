import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';
import { validate_config } from '../../config/index.js';
import create_manifest_data from '../create_manifest_data/index.js';
import { ts } from '../ts.js';
import { worker_declaration, write_worker_declarations } from './write_worker_declarations.js';

test('preserves NodeNext resolution modes and declaration extensions', { timeout: 60000 }, () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-worker-conditions-'));
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
			'node_modules/dual/package.json',
			JSON.stringify({
				name: 'dual',
				type: 'module',
				exports: { '.': { import: './import.d.mts', require: './require.d.cts' } }
			})
		);
		write('node_modules/dual/import.d.mts', 'export declare class Payload { kind: "import" }');
		write('node_modules/dual/require.d.cts', 'export declare class Payload { kind: "require" }');
		const helpers = ['ts', 'mts', 'cts'].map((extension) =>
			write(
				`src/helper.${extension}`,
				'/// <reference lib="webworker" />\nexport { Payload } from "dual";'
			)
		);
		write('src/routes/+page.svelte', '<p>worker</p>');
		const worker = write(
			'src/routes/+page.worker.ts',
			`
			import type { Payload as EsmTs } from '../helper.js';
			import type { Payload as EsmMts } from '../helper.mjs';
			import type { Payload as CommonJs } from '../helper.cjs';
			import type { Payload as Required } from 'dual' with { 'resolution-mode': 'require' };
			export const load = () => ({
				esm_ts: {} as EsmTs,
				esm_mts: {} as EsmMts,
				common_js: {} as CommonJs,
				required: {} as Required,
				inline: {} as import('dual', { with: { 'resolution-mode': 'require' } }).Payload
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
			declare const data: ReturnType<typeof load>;
			const esm_ts: 'import' = data.esm_ts.kind;
			const esm_mts: 'import' = data.esm_mts.kind;
			const common_js: 'require' = data.common_js.kind;
			const required: 'require' = data.required.kind;
			const inline: 'require' = data.inline.kind;
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
		for (const helper of helpers) expect(program.getSourceFile(helper)).toBeUndefined();
		expect(program.getSourceFile(worker)).toBeUndefined();
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});
