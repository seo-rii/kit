import process from 'node:process';
import { test } from '../../../../utils.js';
import { expect } from '../../../../playwright-matchers.js';

test.skip(({ javaScriptEnabled, browserName }) => !javaScriptEnabled || browserName !== 'chromium');
test.skip(!!process.env.DEV, 'These tests exercise the built service worker and its cached assets');

test.beforeEach(async ({ page }) => {
	await page.goto('/offline-plugin/start');
	await page.evaluate(() => navigator.serviceWorker.ready);
	await page.reload();
	await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
});

test('worker-first preserves SSR and supplies layout and page data on navigation', async ({
	page,
	app
}) => {
	await page.goto('/offline-plugin/target');
	await expect(page.locator('#source')).toHaveText('server');
	await expect(page.locator('#parent-source')).toHaveText('server-layout');

	await app.goto('/offline-plugin/start');
	await app.goto('/offline-plugin/target?strategy=worker-first');
	await expect(page.locator('h1')).toHaveText('offline data for /offline-plugin/target');
	await expect(page.locator('#layout-source')).toHaveText('offline-layout');
	await expect(page.locator('#parent-source')).toHaveText('offline-layout');
	await expect(page.locator('#layout-network')).toHaveText('online');
	await expect(page.locator('#network')).toHaveText('online');
	await expect(page.locator('#tracked')).toHaveText('none');
	await expect(page.locator('#path')).toHaveText('/offline-plugin/target');
});

test('partial invalidation keeps parent data available without invalidating the layout', async ({
	page,
	app
}) => {
	await app.goto('/offline-plugin/target?strategy=worker-first&tracked=first');
	await expect(page.locator('#tracked')).toHaveText('first');

	const response_promise = page.waitForResponse((response) => {
		const url = new URL(response.url());
		return (
			url.pathname.endsWith('/offline-plugin/target/__data.json') &&
			url.searchParams.get('tracked') === 'second'
		);
	});
	await app.goto('/offline-plugin/target?strategy=worker-first&tracked=second');
	const response = await response_promise;
	const invalidated = new URL(response.url()).searchParams.get('x-sveltekit-invalidated');

	expect(invalidated).toMatch(/^0+1$/);
	expect(response.headers()['x-sveltekit-version']).toBe('TEST_VERSION');
	await expect(page.locator('#tracked')).toHaveText('second');
	await expect(page.locator('#layout-source')).toHaveText('offline-layout');
	await expect(page.locator('#parent-source')).toHaveText('offline-layout');
});

test('network-first preserves HTTP errors and falls back only when transport fails', async ({
	page,
	app
}) => {
	const response_promise = page.waitForResponse((response) => {
		return new URL(response.url()).pathname.endsWith('/offline-plugin/target/__data.json');
	});
	await app.goto('/offline-plugin/target');
	await expect(page.locator('#source')).toHaveText('server');
	const data_url = (await response_promise).url();

	const result = await page.evaluate(async (url) => {
		const unavailable = await fetch(url, {
			headers: { 'x-offline-test-response': '503' }
		});
		const fallback = await fetch(url, {
			headers: { 'x-offline-test-response': 'transport-error' }
		});
		return {
			httpStatus: unavailable.status,
			httpBody: await unavailable.text(),
			httpSource: unavailable.headers.get('x-offline-test-network'),
			fallbackStatus: fallback.status,
			fallbackBody: await fallback.text()
		};
	}, data_url);

	expect(result.httpStatus).toBe(503);
	expect(result.httpBody).toBe('unavailable');
	expect(result.httpSource).toBe('1');
	expect(result.fallbackStatus).toBe(200);
	expect(result.fallbackBody).toContain('offline data for /offline-plugin/target');
});

test('network-first handles real offline client navigation', async ({ page, app }) => {
	await page.context().setOffline(true);
	try {
		await app.goto('/offline-plugin/target');
		await expect(page.locator('#source')).toHaveText('offline');
		await expect(page.locator('#network')).toHaveText('offline');
		await expect(page.locator('#parent-source')).toHaveText('offline-layout');
	} finally {
		await page.context().setOffline(false);
	}
});

test('passes writes through and does not report offline writes as queued or confirmed', async ({
	page
}) => {
	const online = await page.evaluate(async () => {
		const response = await fetch('/offline-plugin/mutation?strategy=worker-first', {
			method: 'POST',
			body: 'server write'
		});
		return response.json();
	});
	expect(online).toEqual({ state: 'confirmed', message: 'server write' });

	await page.context().setOffline(true);
	try {
		const offline = await page.evaluate(async () => {
			try {
				const response = await fetch('/offline-plugin/mutation?strategy=worker-first', {
					method: 'POST',
					body: 'offline write'
				});
				return response.json();
			} catch {
				return null;
			}
		});
		expect(offline).toBeNull();
	} finally {
		await page.context().setOffline(false);
	}
});

test('streams fulfilled and rejected fallback promises', async ({ page, app }) => {
	await app.goto('/offline-plugin/streaming?strategy=worker-first');
	await expect(page.locator('#eager')).toHaveText('offline eager');
	await expect(page.locator('#stream-loading')).toBeVisible();
	await expect(page.locator('#failure-loading')).toBeVisible();
	await expect(page.locator('#streamed')).toHaveText('offline streamed');
	await expect(page.locator('#failed')).toHaveText('offline rejected');
	await expect(page.locator('#stream-loading')).toBeHidden();
	await expect(page.locator('#failure-loading')).toBeHidden();
});

test('uses matcher output and route precedence for fallback navigation', async ({ page, app }) => {
	await app.goto('/offline-plugin/matched/123?strategy=worker-first');
	await expect(page.locator('h1')).toHaveText('numeric');
	await expect(page.locator('#source')).toHaveText('offline');
	await expect(page.locator('#value')).toHaveText('123');
	await expect(page.locator('#value-type')).toHaveText('number');
	await expect(page.locator('#route')).toHaveText('/offline-plugin/matched/[id=numeric]');

	await app.goto('/offline-plugin/matched/abc?strategy=worker-first');
	await expect(page.locator('h1')).toHaveText('slug');
	await expect(page.locator('#source')).toHaveText('offline');
	await expect(page.locator('#value')).toHaveText('abc');
	await expect(page.locator('#value-type')).toHaveText('string');
	await expect(page.locator('#route')).toHaveText('/offline-plugin/matched/[slug]');
});

test('reroutes offline data requests while preserving the visible URL', async ({ page, app }) => {
	await page.context().setOffline(true);
	try {
		await app.goto('/offline-plugin/reroute-visible');
		await expect(page).toHaveURL('/offline-plugin/reroute-visible');
		await expect(page.locator('#source')).toHaveText('offline');
		await expect(page.locator('#route')).toHaveText('/offline-plugin/reroute-target');
		await expect(page.locator('#pathname')).toHaveText('/offline-plugin/reroute-visible');
	} finally {
		await page.context().setOffline(false);
	}
});
