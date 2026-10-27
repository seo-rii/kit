import { randomUUID } from 'node:crypto';
import process from 'node:process';
import { test } from '../../../../utils.js';
import { expect } from '../../../../playwright-matchers.js';

test.skip(({ javaScriptEnabled, browserName }) => !javaScriptEnabled || browserName !== 'chromium');
test.skip(!!process.env.DEV, 'These tests exercise the built service worker and browser storage');

test.beforeEach(async ({ page }) => {
	const identity = randomUUID();
	await page.goto(`/offline-plugin/outbox?db=${identity}&scope=${identity}`);
	await page.evaluate(() => navigator.serviceWorker.ready);
	await page.reload();
	await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
	await expect(page.locator('#outbox-ready')).toHaveText('ready');
});

test('durably queues explicit work offline and preserves it through reload', async ({ page }) => {
	await page.context().setOffline(true);
	try {
		const entry = await page.evaluate(() =>
			window.offline_outbox.enqueue('edit-1', { title: 'Offline edit' })
		);
		expect(entry.status).toBe('pending');
		expect(entry.attempts).toBe(0);
		expect(await page.evaluate(() => window.offline_outbox.senderCalls)).toBe(0);
	} finally {
		await page.context().setOffline(false);
	}

	// Reconnecting only loads the document; it must not implicitly flush the queue.
	await page.reload();
	await expect(page.locator('#outbox-ready')).toHaveText('ready');
	const entries = await page.evaluate(() => window.offline_outbox.list());
	expect(entries).toHaveLength(1);
	expect(entries[0]).toMatchObject({
		id: 'edit-1',
		payload: { title: 'Offline edit' },
		status: 'pending',
		attempts: 0
	});
	expect(await page.evaluate(() => window.offline_outbox.stats('edit-1'))).toEqual({
		effects: 0,
		requests: 0
	});

	const flushed = await page.evaluate(() => window.offline_outbox.flush());
	expect(flushed[0].status).toBe('confirmed');
	expect(await page.evaluate(() => window.offline_outbox.stats('edit-1'))).toEqual({
		effects: 1,
		requests: 1
	});
});

test('recovers a lost receipt after restart only through explicit idempotent retry', async ({
	page
}) => {
	await page.evaluate(async () => {
		window.offline_outbox.setLoss(true);
		await window.offline_outbox.enqueue('edit-1', { title: 'Already committed' });
	});
	const uncertain = await page.evaluate(() => window.offline_outbox.flush());
	expect(uncertain[0]).toMatchObject({ status: 'unknown', attempts: 1 });
	expect(await page.evaluate(() => window.offline_outbox.stats('edit-1'))).toEqual({
		effects: 1,
		requests: 1
	});

	await page.evaluate(() => window.offline_outbox.flush());
	expect(await page.evaluate(() => window.offline_outbox.stats('edit-1'))).toEqual({
		effects: 1,
		requests: 1
	});
	await page.reload();
	await expect(page.locator('#outbox-ready')).toHaveText('ready');
	expect((await page.evaluate(() => window.offline_outbox.flush()))[0].status).toBe('unknown');
	expect(await page.evaluate(() => window.offline_outbox.stats('edit-1'))).toEqual({
		effects: 1,
		requests: 1
	});

	const retried = await page.evaluate(() => window.offline_outbox.flush({ retryUnknown: true }));
	expect(retried[0]).toMatchObject({ status: 'confirmed', attempts: 2, receipt: { effect: 1 } });
	expect(await page.evaluate(() => window.offline_outbox.stats('edit-1'))).toEqual({
		effects: 1,
		requests: 2
	});
});

test('uses a cross-tab Web Lock so simultaneous flushes submit only once', async ({ page }) => {
	const other = await page.context().newPage();
	await other.goto(page.url());
	await expect(other.locator('#outbox-ready')).toHaveText('ready');
	await page.evaluate(async () => {
		await window.offline_outbox.enqueue('edit-1', { count: 1 });
		window.offline_outbox.pauseSender();
	});

	const first = page.evaluate(() => window.offline_outbox.flush());
	/** @type {Promise<import('sveltekit-offline/outbox').OutboxEntry[]> | undefined} */
	let second;
	try {
		await expect.poll(() => page.evaluate(() => window.offline_outbox.senderCalls)).toBe(1);
		second = other.evaluate(() => window.offline_outbox.flush({ retryUnknown: true }));
		await expect
			.poll(() =>
				other.evaluate(async () => {
					const locks = await navigator.locks.query();
					return locks.pending?.filter((lock) => lock.name?.startsWith('sveltekit-offline-outbox:'))
						.length;
				})
			)
			.toBe(1);
		expect(await other.evaluate(() => window.offline_outbox.senderCalls)).toBe(0);
		await page.evaluate(() => window.offline_outbox.resumeSender());

		const [left, right] = await Promise.all([first, second]);
		expect(left[0].status).toBe('confirmed');
		expect(right).toEqual(left);
		expect(await page.evaluate(() => window.offline_outbox.stats('edit-1'))).toEqual({
			effects: 1,
			requests: 1
		});
	} finally {
		await page.evaluate(() => window.offline_outbox.resumeSender());
		await Promise.allSettled([first, ...(second ? [second] : [])]);
		await other.close();
	}
});

test('isolates different user scopes in the same IndexedDB database', async ({ page }) => {
	const other = await page.context().newPage();
	const url = new URL(page.url());
	url.searchParams.set('scope', randomUUID());
	try {
		await other.goto(url.href);
		await expect(other.locator('#outbox-ready')).toHaveText('ready');
		await page.evaluate(() => window.offline_outbox.enqueue('edit-1', { private: 'first user' }));
		await other.evaluate(() => window.offline_outbox.enqueue('edit-1', { private: 'second user' }));
		await page.evaluate(() => window.offline_outbox.flush());

		const entries = await other.evaluate(() => window.offline_outbox.list());
		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({ status: 'pending', payload: { private: 'second user' } });
		expect(await other.evaluate(() => window.offline_outbox.stats('edit-1'))).toEqual({
			effects: 0,
			requests: 0
		});
		expect(await page.evaluate(() => window.offline_outbox.stats('edit-1'))).toEqual({
			effects: 1,
			requests: 1
		});
	} finally {
		await other.close();
	}
});
