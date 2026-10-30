import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { expect, test } from 'vitest';

test('bundles worker fallbacks without exposing Kit dependencies to the app', () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-worker-dependencies-'));
	const kit = fileURLToPath(new URL('../../../', import.meta.url));
	const require = createRequire(import.meta.url);

	try {
		/** @param {string} name @param {string} contents */
		const write = (name, contents) => {
			const file = path.join(root, name);
			fs.mkdirSync(path.dirname(file), { recursive: true });
			fs.writeFileSync(file, contents);
		};

		// An app using pnpm only sees Kit and its peers, not Kit's transitive dependencies.
		for (const [name, target] of [
			['@sveltejs/kit', kit],
			...['svelte', 'vite', '@sveltejs/vite-plugin-svelte'].map((name) => [
				name,
				fs.realpathSync(path.join(kit, 'node_modules', name))
			])
		]) {
			const link = path.join(root, 'node_modules', name);
			fs.mkdirSync(path.dirname(link), { recursive: true });
			fs.symlinkSync(target, link, 'junction');
		}

		write('package.json', JSON.stringify({ type: 'module', private: true }));
		write(
			'src/app.html',
			'<!doctype html><html><head>%sveltekit.head%</head><body><div>%sveltekit.body%</div></body></html>'
		);
		write('src/routes/+page.svelte', '<h1>Worker fallback</h1>');
		write('src/routes/+page.server.js', 'export const load = () => ({ source: "server" });');
		write('src/routes/+page.worker.js', 'export const load = () => ({ source: "worker" });');
		write(
			'src/service-worker.js',
			'import { resolve, self } from "$app/service-worker"; self.addEventListener("fetch", (event) => event.respondWith(resolve(event)));'
		);

		write(
			'build.mjs',
			`
					import assert from 'node:assert/strict';
					import { createRequire } from 'node:module';
					import path from 'node:path';
					import { createBuilder } from ${JSON.stringify(pathToFileURL(require.resolve('vite')).href)};
					import { sveltekit } from ${JSON.stringify(new URL('./index.js', import.meta.url).href)};
					assert.throws(() => createRequire(path.join(process.cwd(), 'package.json')).resolve('devalue'));
					const builder = await createBuilder({
						configFile: false,
						plugins: [sveltekit({
							experimental: { serviceWorkerFallbacks: true },
							adapter: { name: 'test-adapter', adapt() {} }
						})],
						logLevel: 'silent'
					});
					await builder.buildApp();
			`
		);
		execFileSync(process.execPath, ['build.mjs'], {
			cwd: root,
			// pnpm's test runner shim exposes its own dependencies through NODE_PATH.
			env: { ...process.env, NODE_PATH: '' },
			encoding: 'utf8',
			timeout: 60000,
			stdio: ['ignore', 'pipe', 'pipe']
		});

		expect(fs.existsSync(path.join(root, '.svelte-kit/output/client/service-worker.js'))).toBe(
			true
		);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
}, 60000);
