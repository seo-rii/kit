import process from 'node:process';
import { test } from '../../../../utils.js';
import { expect } from '../../../../playwright-matchers.js';

test.skip(({ javaScriptEnabled, browserName }) => !javaScriptEnabled || browserName !== 'chromium');
test.skip(!!process.env.DEV, 'These tests exercise the built service worker and remote responses');

test.beforeEach(async ({ page }) => {
	await page.goto('/offline-plugin/start');
	await page.evaluate(() => navigator.serviceWorker.ready);
	await page.reload();
	await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
	await page.goto('/offline-plugin/remote');
});

test('a real remote query opts into offline caching without changing its payload', async ({
	page
}) => {
	const response_promise = page.waitForResponse((response) =>
		new URL(response.url()).pathname.endsWith('/offline_cached_items')
	);
	await page.locator('#read-cached').click();
	await expect(page.locator('#cached-status')).toHaveText('ready');
	const online = await response_promise;
	expect(online.request().method()).toBe('GET');
	expect(online.headers()['cache-control']).toBe('private, max-age=60');
	const online_body = await online.text();
	const value = await page.locator('#cached-value').textContent();
	const stored_at = await page.evaluate(async (url) => {
		const names = await caches.keys();
		const name = names.find(
			(value) =>
				value.startsWith('sveltekit-offline:') && value.includes('offline-plugin-test-fixture')
		);
		if (!name) return null;
		const cached = await (await caches.open(name)).match(url);
		return cached?.headers.get('x-sveltekit-offline-stored-at');
	}, online.url());
	expect(stored_at).toMatch(/^\d+$/);

	await page.context().setOffline(true);
	try {
		const fallback_promise = page.waitForResponse((response) => response.url() === online.url());
		await page.locator('#read-cached').click();
		await expect(page.locator('#cached-attempts')).toHaveText('2');
		await expect(page.locator('#cached-status')).toHaveText('ready');
		await expect(page.locator('#cached-value')).toHaveText(value ?? '');
		const fallback = await fallback_promise;
		expect(await fallback.text()).toBe(online_body);
		expect(fallback.headers()['x-sveltekit-offline-stored-at']).toBeUndefined();
		expect(fallback.headers().age).toMatch(/^\d+$/);
	} finally {
		await page.context().setOffline(false);
	}
});

test('a default no-store remote query stays unavailable offline', async ({ page }) => {
	const response_promise = page.waitForResponse((response) =>
		new URL(response.url()).pathname.endsWith('/offline_uncached_items')
	);
	await page.locator('#read-uncached').click();
	await expect(page.locator('#uncached-status')).toHaveText('ready');
	expect((await response_promise).headers()['cache-control']).toContain('no-store');

	await page.context().setOffline(true);
	try {
		await page.locator('#read-uncached').click();
		await expect(page.locator('#uncached-attempts')).toHaveText('2');
		await expect(page.locator('#uncached-status')).toHaveText('error');
	} finally {
		await page.context().setOffline(false);
	}
});

test('a command is sent once and invalidates previously cached query data', async ({ page }) => {
	await page.locator('#read-cached').click();
	await expect(page.locator('#cached-status')).toHaveText('ready');
	const before = Number(await page.locator('#cached-value').textContent());
	let commands = 0;
	page.on('request', (request) => {
		if (new URL(request.url()).pathname.endsWith('/offline_write')) commands += 1;
	});

	await page.locator('#mutate').click();
	await expect(page.locator('#mutation-status')).toHaveText('confirmed');
	await expect(page.locator('#mutation-value')).toHaveText(String(before + 1));
	expect(commands).toBe(1);

	await page.context().setOffline(true);
	try {
		await page.locator('#read-cached').click();
		await expect(page.locator('#cached-attempts')).toHaveText('2');
		await expect(page.locator('#cached-status')).toHaveText('error');
		expect(commands).toBe(1);
	} finally {
		await page.context().setOffline(false);
	}
});

test('a real live query streams normally and cannot fall back to CacheStorage', async ({
	page
}) => {
	const response_promise = page.waitForResponse((response) =>
		new URL(response.url()).pathname.endsWith('/offline_live_items')
	);
	await page.locator('#read-live').click();
	await expect(page.locator('#live-status')).toHaveText('done');
	await expect(page.locator('#live-values')).toContainText('first live value');
	await expect(page.locator('#live-values')).toContainText('second live value');
	const response = await response_promise;
	expect(response.headers()['content-type']).toContain('text/event-stream');
	expect(response.request().headers().accept).toBe('text/event-stream');

	await page.context().setOffline(true);
	try {
		const cached = await page.evaluate(async (url) => {
			try {
				await fetch(url, { headers: { accept: 'text/event-stream' } });
				return true;
			} catch {
				return false;
			}
		}, response.url());
		expect(cached).toBe(false);
	} finally {
		await page.context().setOffline(false);
	}
});
