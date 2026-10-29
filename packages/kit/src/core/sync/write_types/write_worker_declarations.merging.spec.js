import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';
import { validate_config } from '../../config/index.js';
import create_manifest_data from '../create_manifest_data/index.js';
import { ts } from '../ts.js';
import { worker_declaration, write_worker_declarations } from './write_worker_declarations.js';

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
