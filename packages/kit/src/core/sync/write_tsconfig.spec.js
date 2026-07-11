import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assert, expect, test } from 'vitest';
import { validate_config } from '../config/index.js';
import { get_tsconfig, get_worker_tsconfig, write_tsconfig } from './write_tsconfig.js';

test('Creates tsconfig path aliases from kit.alias', () => {
	const { kit } = validate_config({
		kit: {
			alias: {
				simpleKey: 'simple/value',
				key: 'value',
				'key/*': 'some/other/value/*',
				keyToFile: 'path/to/file.ts',
				$routes: '.svelte-kit/types/src/routes'
			}
		}
	});

	const { compilerOptions } = get_tsconfig(kit);

	// $lib isn't part of the outcome because there's a "path exists"
	// check in the implementation
	expect(compilerOptions.paths).toEqual({
		'$app/types': ['./types/index.d.ts'],
		simpleKey: ['../simple/value'],
		'simpleKey/*': ['../simple/value/*'],
		key: ['../value'],
		'key/*': ['../some/other/value/*'],
		keyToFile: ['../path/to/file.ts'],
		$routes: ['./types/src/routes'],
		'$routes/*': ['./types/src/routes/*']
	});
});

test('Allows generated tsconfig to be mutated', () => {
	const { kit } = validate_config({
		kit: {
			typescript: {
				config: (config) => {
					config.extends = 'some/other/tsconfig.json';
				}
			}
		}
	});

	const config = get_tsconfig(kit);

	// @ts-expect-error
	assert.equal(config.extends, 'some/other/tsconfig.json');
});

test('Allows generated tsconfig to be replaced', () => {
	const { kit } = validate_config({
		kit: {
			typescript: {
				config: (config) => ({
					...config,
					extends: 'some/other/tsconfig.json'
				})
			}
		}
	});

	const config = get_tsconfig(kit);

	// @ts-expect-error
	assert.equal(config.extends, 'some/other/tsconfig.json');
});

test('Creates tsconfig include from kit.files', () => {
	const { kit } = validate_config({
		kit: {
			files: {
				lib: 'app'
			}
		}
	});

	const { include } = get_tsconfig(kit);

	expect(include).toEqual([
		'ambient.d.ts',
		'env.d.ts',
		'non-ambient.d.ts',
		'./types/**/$types.d.ts',
		'../vite.config.js',
		'../vite.config.ts',
		'../app/**/*.js',
		'../app/**/*.ts',
		'../app/**/*.svelte',
		'../src/**/*.js',
		'../src/**/*.ts',
		'../src/**/*.svelte',
		'../test/**/*.js',
		'../test/**/*.ts',
		'../test/**/*.svelte',
		'../tests/**/*.js',
		'../tests/**/*.ts',
		'../tests/**/*.svelte'
	]);
});

test('Excludes route worker modules from the app TypeScript program', () => {
	const { kit } = validate_config({
		kit: {
			experimental: {
				serviceWorkerFallbacks: true
			}
		}
	});

	const { exclude } = get_tsconfig(kit);

	expect(exclude).toEqual(
		expect.arrayContaining([
			'../src/routes/**/+page.worker.js',
			'../src/routes/**/+page.worker.ts',
			'../src/routes/**/+layout.worker.js',
			'../src/routes/**/+layout.worker.ts'
		])
	);
});

test('Uses configured routes and module extensions for route worker exclusions', () => {
	const { kit } = validate_config({
		kit: {
			experimental: {
				serviceWorkerFallbacks: true
			},
			files: {
				routes: 'app/pages'
			},
			moduleExtensions: ['.mjs', '.mts']
		}
	});

	const { exclude } = get_tsconfig(kit);

	expect(exclude).toEqual(
		expect.arrayContaining([
			'../app/pages/**/+page.worker.mjs',
			'../app/pages/**/+page.worker.mts',
			'../app/pages/**/+layout.worker.mjs',
			'../app/pages/**/+layout.worker.mts'
		])
	);
	expect(exclude).not.toContain('../src/routes/**/+page.worker.js');
});

test('Does not change app TypeScript exclusions when worker fallbacks are disabled', () => {
	const { kit } = validate_config({});

	const { exclude } = get_tsconfig(kit);

	expect(exclude).not.toContain('../src/routes/**/+page.worker.js');
	expect(exclude).not.toContain('../src/routes/**/+layout.worker.ts');
});

test('Removes a stale worker TypeScript config when worker fallbacks are disabled', () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sveltekit-worker-tsconfig-'));
	const outDir = path.join(cwd, '.svelte-kit');
	fs.mkdirSync(outDir);
	fs.writeFileSync(path.join(outDir, 'tsconfig.worker.json'), '{}');

	try {
		const { kit } = validate_config({ kit: { outDir } });
		write_tsconfig(kit, cwd);

		expect(fs.existsSync(path.join(outDir, 'tsconfig.worker.json'))).toBe(false);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test('Creates a separate Web Worker TypeScript program for route worker modules', () => {
	const { kit } = validate_config({});

	const config = get_worker_tsconfig(kit);

	expect(config).toEqual({
		extends: './tsconfig.json',
		compilerOptions: {
			lib: ['esnext', 'WebWorker', 'WebWorker.Iterable'],
			skipLibCheck: true,
			types: []
		},
		include: [
			'ambient.d.ts',
			'env.d.ts',
			'non-ambient.d.ts',
			'./types/**/$worker-types.d.ts',
			'../src/**/*.d.ts',
			'../src/routes/**/+page.worker.js',
			'../src/routes/**/+page.worker.ts',
			'../src/routes/**/+layout.worker.js',
			'../src/routes/**/+layout.worker.ts'
		],
		exclude: ['../node_modules/**']
	});
});

test('Worker TypeScript program inherits user options and configured route extensions', () => {
	const { kit } = validate_config({
		kit: {
			files: {
				routes: 'app/pages'
			},
			moduleExtensions: ['.mjs', '.mts']
		}
	});

	const config = get_worker_tsconfig(kit, path.resolve('tsconfig.json'));

	expect(config.extends).toBe('../tsconfig.json');
	expect(config.include).toEqual(
		expect.arrayContaining([
			'../app/pages/**/+page.worker.mjs',
			'../app/pages/**/+page.worker.mts',
			'../app/pages/**/+layout.worker.mjs',
			'../app/pages/**/+layout.worker.mts'
		])
	);
});
