import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';
import { validate_config } from '../../config/index.js';
import { write_tsconfig } from './index.js';

test('isolates route worker modules in a service worker TypeScript project', () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-route-worker-tsconfig-'));

	try {
		const { kit } = validate_config({
			kit: {
				experimental: {
					serviceWorkerFallbacks: true
				}
			}
		});

		kit.files.src = path.join(root, 'src');
		kit.files.routes = path.join(root, 'src/routes');
		kit.files.serviceWorker = path.join(root, 'src/service-worker');
		kit.outDir = path.join(root, '.svelte-kit');

		write_tsconfig(kit, root);

		const app_config = JSON.parse(
			fs.readFileSync(path.join(root, 'node_modules/$app/tsconfig/tsconfig.json'), 'utf8')
		);
		expect(app_config.exclude).toEqual(
			expect.arrayContaining([
				'../../../src/routes/**/+page.worker.js',
				'../../../src/routes/**/+page.worker.ts',
				'../../../src/routes/**/+layout.worker.js',
				'../../../src/routes/**/+layout.worker.ts'
			])
		);

		const worker_config_file = path.join(kit.outDir, 'tsconfig.worker.json');
		const worker_config = JSON.parse(fs.readFileSync(worker_config_file, 'utf8'));
		expect(worker_config).toMatchObject({
			extends: '$app/tsconfig/service-worker',
			compilerOptions: {
				rootDirs: ['..', 'types'],
				skipLibCheck: true
			}
		});
		expect(worker_config.include).toEqual(
			expect.arrayContaining([
				'../src/routes/**/+page.worker.js',
				'../src/routes/**/+page.worker.ts',
				'../src/routes/**/+layout.worker.js',
				'../src/routes/**/+layout.worker.ts',
				'types/**/$worker-types.d.ts'
			])
		);

		kit.experimental.serviceWorkerFallbacks = false;
		write_tsconfig(kit, root);

		expect(fs.existsSync(worker_config_file)).toBe(false);
		const disabled_app_config = JSON.parse(
			fs.readFileSync(path.join(root, 'node_modules/$app/tsconfig/tsconfig.json'), 'utf8')
		);
		expect(disabled_app_config.exclude).not.toEqual(
			expect.arrayContaining([expect.stringContaining('+page.worker')])
		);

		kit.experimental.serviceWorkerFallbacks = true;
		write_tsconfig(kit, root);
		expect(fs.existsSync(worker_config_file)).toBe(true);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});
