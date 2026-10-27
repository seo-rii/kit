/** @import { JsonValue, OutboxEntry, OutboxLock, OutboxStore } from './outbox-public.js' */
import { afterEach, describe, expect, test, vi } from 'vitest';
import { createOutbox } from './outbox.js';

afterEach(() => vi.unstubAllGlobals());

function memory_store() {
	/** @type {Map<string, OutboxEntry>} */
	const entries = new Map();
	return {
		name: 'test-store',
		get: vi.fn(
			/** @type {OutboxStore['get']} */
			(scope, id) =>
				Promise.resolve(structuredClone(entries.get(JSON.stringify([scope, id])) ?? null))
		),
		list: vi.fn(
			/** @type {OutboxStore['list']} */
			(scope) =>
				Promise.resolve(
					structuredClone([...entries.values()].filter((entry) => entry.scope === scope))
				)
		),
		put: vi.fn(
			/** @type {OutboxStore['put']} */
			(entry) => {
				entries.set(JSON.stringify([entry.scope, entry.id]), structuredClone(entry));
				return Promise.resolve();
			}
		)
	};
}

/** @returns {OutboxLock} */
function serial_lock() {
	/** @type {Map<string, Promise<void>>} */
	const queues = new Map();
	return (name, run) => {
		const previous = queues.get(name) ?? Promise.resolve();
		const result = previous.then(run);
		queues.set(
			name,
			result.then(
				() => undefined,
				() => undefined
			)
		);
		return result;
	};
}

function setup() {
	const store = memory_store();
	const lock = serial_lock();
	const sender = {
		idempotency: /** @type {const} */ ('operation-id'),
		send: vi.fn().mockResolvedValue({ status: 'confirmed', receipt: { revision: 1 } })
	};
	const options = { scope: 'user-a', store, lock, sender };
	return { ...options, outbox: createOutbox(options) };
}

describe('explicit durable enqueue', () => {
	test('persists pending before reporting it and never sends implicitly', async () => {
		const { outbox, store, sender } = setup();
		const entry = await outbox.enqueue({ id: 'edit-1', payload: { title: 'Offline edit' } });

		expect(entry).toEqual({
			scope: 'user-a',
			id: 'edit-1',
			payload: { title: 'Offline edit' },
			status: 'pending',
			attempts: 0
		});
		expect(await store.get('user-a', 'edit-1')).toEqual(entry);
		expect(sender.send).not.toHaveBeenCalled();
	});

	test('does not report a queue entry when persistence fails', async () => {
		const { outbox, store, sender } = setup();
		const error = new DOMException('Storage full', 'QuotaExceededError');
		store.put.mockRejectedValueOnce(error);

		await expect(outbox.enqueue({ id: 'edit-1', payload: { title: 'Offline edit' } })).rejects.toBe(
			error
		);
		expect(await outbox.list()).toEqual([]);
		expect(sender.send).not.toHaveBeenCalled();
	});

	test('accepts identical JSON without duplicating or resetting the operation', async () => {
		const { outbox, store } = setup();
		await outbox.enqueue({ id: 'edit-1', payload: { title: 'Offline edit', count: 1 } });
		await outbox.flush();
		const writes = store.put.mock.calls.length;
		const repeated = await outbox.enqueue({
			id: 'edit-1',
			payload: { count: 1, title: 'Offline edit' }
		});

		expect(repeated.status).toBe('confirmed');
		expect(store.put).toHaveBeenCalledTimes(writes);
	});

	test('rejects reusing the same scoped ID with different data', async () => {
		const { outbox, store } = setup();
		await outbox.enqueue({ id: 'edit-1', payload: { count: 1 } });

		await expect(outbox.enqueue({ id: 'edit-1', payload: { count: 2 } })).rejects.toThrow(
			'different payload'
		);
		expect(store.put).toHaveBeenCalledTimes(1);
		expect((await outbox.list())[0].payload).toEqual({ count: 1 });
	});

	test('serializes racing enqueues with the same ID', async () => {
		const { outbox, store, lock, sender } = setup();
		const other = createOutbox({ scope: 'user-a', store, lock, sender });
		const results = await Promise.allSettled([
			outbox.enqueue({ id: 'edit-1', payload: 'first' }),
			other.enqueue({ id: 'edit-1', payload: 'second' })
		]);

		expect(results.map((result) => result.status)).toEqual(['fulfilled', 'rejected']);
		expect(store.put).toHaveBeenCalledTimes(1);
		expect((await outbox.list())[0].payload).toBe('first');
	});

	test('snapshots input and returned values so later mutation cannot alter retries', async () => {
		const { outbox, sender } = setup();
		const payload = { nested: { count: 1 } };
		const enqueued = await outbox.enqueue({ id: 'edit-1', payload });
		payload.nested.count = 2;
		/** @type {typeof payload} */ (enqueued.payload).nested.count = 3;
		const listed = await outbox.list();
		/** @type {typeof payload} */ (listed[0].payload).nested.count = 4;
		await outbox.flush();

		expect(sender.send.mock.calls[0][0].payload).toEqual({ nested: { count: 1 } });
	});

	test.each([
		{ payload: undefined },
		{ payload: NaN },
		{ payload: Infinity },
		{ payload: { missing: undefined } },
		{ payload: new Date() },
		{ payload: [, 1] }
	])('rejects non-JSON data instead of silently changing it: %j', async ({ payload }) => {
		const { outbox, store } = setup();
		// @ts-expect-error Runtime validation must reject values outside the JSON contract.
		await expect(outbox.enqueue({ id: 'edit-1', payload })).rejects.toThrow(TypeError);
		expect(store.put).not.toHaveBeenCalled();
	});

	test('rejects cyclic payloads', async () => {
		const { outbox, store } = setup();
		/** @type {{ [key: string]: JsonValue }} */
		const payload = {};
		payload.self = payload;
		await expect(outbox.enqueue({ id: 'edit-1', payload })).rejects.toThrow(TypeError);
		expect(store.put).not.toHaveBeenCalled();
	});

	test('requires an explicit server idempotency contract', () => {
		expect(() => {
			// @ts-expect-error Omitting the required idempotency contract must fail at runtime.
			return createOutbox({ scope: 'user-a', store: memory_store(), sender: { send: vi.fn() } });
		}).toThrow('idempotency');
	});

	test('does not write without Web Locks or an injected cross-context lock', async () => {
		vi.stubGlobal('navigator', {});
		const { store, sender } = setup();
		const outbox = createOutbox({ scope: 'user-a', store, sender });

		await expect(outbox.enqueue({ id: 'edit-1', payload: null })).rejects.toThrow('Web Locks');
		expect(store.put).not.toHaveBeenCalled();
	});
});

describe('explicit send and receipts', () => {
	test('persists uncertainty before sending and confirms only with a persisted receipt', async () => {
		const { outbox, store, sender } = setup();
		await outbox.enqueue({ id: 'edit-1', payload: { count: 1 } });
		sender.send.mockImplementationOnce(async () => {
			expect(await store.get('user-a', 'edit-1')).toMatchObject({ status: 'unknown', attempts: 1 });
			return { status: 'confirmed', receipt: { revision: 5 } };
		});

		const result = await outbox.flush();
		expect(result[0]).toMatchObject({ status: 'confirmed', receipt: { revision: 5 }, attempts: 1 });
		expect(await store.get('user-a', 'edit-1')).toEqual(result[0]);
	});

	test('does not send if recording the attempt fails', async () => {
		const { outbox, store, sender } = setup();
		await outbox.enqueue({ id: 'edit-1', payload: null });
		const error = new Error('Write transaction aborted');
		store.put.mockRejectedValueOnce(error);

		await expect(outbox.flush()).rejects.toBe(error);
		expect(sender.send).not.toHaveBeenCalled();
		expect((await outbox.list())[0].status).toBe('pending');
		expect((await outbox.flush())[0].status).toBe('confirmed');
	});

	test('only an explicit server rejection is terminal', async () => {
		const { outbox, sender } = setup();
		await outbox.enqueue({ id: 'edit-1', payload: null });
		sender.send.mockResolvedValue({ status: 'rejected', reason: { code: 'version-conflict' } });

		expect((await outbox.flush())[0]).toMatchObject({
			status: 'rejected',
			reason: { code: 'version-conflict' }
		});
		await outbox.flush({ retryUnknown: true });
		expect(sender.send).toHaveBeenCalledTimes(1);
	});

	test.each([undefined, { status: 'confirmed' }, { status: 'ok', receipt: 1 }])(
		'keeps unknown for a missing or invalid explicit receipt: %j',
		async (receipt) => {
			const { outbox, sender } = setup();
			await outbox.enqueue({ id: 'edit-1', payload: null });
			sender.send.mockResolvedValue(receipt);

			await expect(outbox.flush()).rejects.toThrow(TypeError);
			expect((await outbox.list())[0].status).toBe('unknown');
		}
	);

	test('recovers a lost response after commit using the same ID and server deduplication', async () => {
		const { outbox, store, lock, sender } = setup();
		const committed = new Map();
		let writes = 0;
		sender.send.mockImplementation(({ scope, id, payload }) => {
			const key = JSON.stringify([scope, id]);
			if (committed.has(key)) return Promise.resolve(committed.get(key));
			writes += 1;
			const receipt = { status: 'confirmed', receipt: { revision: writes, payload } };
			committed.set(key, receipt);
			return Promise.reject(new TypeError('Response lost after server commit'));
		});
		await outbox.enqueue({ id: 'edit-1', payload: { count: 1 } });

		expect((await outbox.flush())[0].status).toBe('unknown');
		await outbox.flush();
		expect(sender.send).toHaveBeenCalledTimes(1);

		const restarted = createOutbox({ scope: 'user-a', store, lock, sender });
		await restarted.flush();
		expect(sender.send).toHaveBeenCalledTimes(1);
		const result = await restarted.flush({ retryUnknown: true });
		expect(result[0]).toMatchObject({ status: 'confirmed', attempts: 2, receipt: { revision: 1 } });
		expect(writes).toBe(1);
		expect(sender.send).toHaveBeenCalledTimes(2);
		expect(sender.send.mock.calls[1][0]).toEqual(sender.send.mock.calls[0][0]);
	});

	test('leaves recoverable unknown state if persisting confirmation fails', async () => {
		const { outbox, store, lock, sender } = setup();
		await outbox.enqueue({ id: 'edit-1', payload: { count: 1 } });
		const put = store.put.getMockImplementation();
		if (!put) throw new Error('Expected an initialized memory store');
		const error = new DOMException('Storage full', 'QuotaExceededError');
		store.put.mockImplementation(async (entry) => {
			if (entry.status === 'confirmed') throw error;
			await put(entry);
		});

		await expect(outbox.flush()).rejects.toBe(error);
		expect((await outbox.list())[0]).toMatchObject({ status: 'unknown', attempts: 1 });
		store.put.mockImplementation(put);
		const restarted = createOutbox({ scope: 'user-a', store, lock, sender });
		await restarted.flush();
		expect(sender.send).toHaveBeenCalledTimes(1);
		expect((await restarted.flush({ retryUnknown: true }))[0].status).toBe('confirmed');
		expect(sender.send.mock.calls[1][0]).toEqual(sender.send.mock.calls[0][0]);
	});

	test('protects the stored payload from mutation by the sender', async () => {
		const { outbox, sender } = setup();
		await outbox.enqueue({ id: 'edit-1', payload: { count: 1 } });
		sender.send.mockImplementationOnce(({ payload }) => {
			payload.count = 999;
			throw new TypeError('Connection lost');
		});

		await outbox.flush();
		await outbox.flush({ retryUnknown: true });
		expect(sender.send.mock.calls[1][0].payload).toEqual({ count: 1 });
	});
});

describe('concurrency and scope', () => {
	test('coalesces concurrent flushes without submitting twice', async () => {
		const { outbox, sender } = setup();
		const started = Promise.withResolvers();
		const finish = Promise.withResolvers();
		await outbox.enqueue({ id: 'edit-1', payload: null });
		sender.send.mockImplementation(async () => {
			started.resolve(undefined);
			await finish.promise;
			return { status: 'confirmed', receipt: 1 };
		});

		const first = outbox.flush();
		const second = outbox.flush({ retryUnknown: true });
		expect(second).toBe(first);
		await started.promise;
		expect((await outbox.list())[0].status).toBe('unknown');
		expect(sender.send).toHaveBeenCalledTimes(1);
		finish.resolve(undefined);
		const results = await Promise.all([first, second]);
		expect(results[0][0].status).toBe('confirmed');
		expect(results[1]).toEqual(results[0]);
	});

	test('serializes independent instances sharing the same store and scope', async () => {
		const { outbox, store, lock, sender } = setup();
		const other = createOutbox({ scope: 'user-a', store, lock, sender });
		const started = Promise.withResolvers();
		const finish = Promise.withResolvers();
		await outbox.enqueue({ id: 'edit-1', payload: null });
		sender.send.mockImplementation(async () => {
			started.resolve(undefined);
			await finish.promise;
			return { status: 'confirmed', receipt: 1 };
		});

		const first = outbox.flush();
		const second = other.flush({ retryUnknown: true });
		await started.promise;
		expect(sender.send).toHaveBeenCalledTimes(1);
		finish.resolve(undefined);
		const results = await Promise.all([first, second]);
		expect(sender.send).toHaveBeenCalledTimes(1);
		expect(results[0]).toEqual(results[1]);
	});

	test('isolates users even when they use the same operation ID', async () => {
		const { outbox, store, lock, sender } = setup();
		const other = createOutbox({ scope: 'user-b', store, lock, sender });
		await outbox.enqueue({ id: 'edit-1', payload: 'private to a' });
		await other.enqueue({ id: 'edit-1', payload: 'private to b' });
		await outbox.flush();

		expect(await other.list()).toEqual([
			{ scope: 'user-b', id: 'edit-1', payload: 'private to b', status: 'pending', attempts: 0 }
		]);
		expect(sender.send).toHaveBeenCalledTimes(1);
		expect(sender.send.mock.calls[0][0]).toMatchObject({
			scope: 'user-a',
			payload: 'private to a'
		});
		await other.flush();
		expect(sender.send.mock.calls[1][0]).toMatchObject({
			scope: 'user-b',
			payload: 'private to b'
		});
	});
});

describe('cancellation and timeout', () => {
	test('leaves unsent work pending when flush is already aborted', async () => {
		const { outbox, sender } = setup();
		await outbox.enqueue({ id: 'edit-1', payload: null });
		const controller = new AbortController();
		controller.abort();

		await expect(outbox.flush({ signal: controller.signal })).rejects.toBe(
			controller.signal.reason
		);
		expect((await outbox.list())[0].status).toBe('pending');
		expect(sender.send).not.toHaveBeenCalled();
	});

	test.each(['AbortError', 'TimeoutError'])(
		'keeps a possible commit unknown on %s',
		async (name) => {
			const { outbox, sender } = setup();
			await outbox.enqueue({ id: 'edit-1', payload: null });
			await outbox.enqueue({ id: 'edit-2', payload: null });
			const controller = new AbortController();
			sender.send.mockImplementationOnce(({ signal }) => {
				expect(signal).toBe(controller.signal);
				controller.abort(new DOMException('Request ended after possible commit', name));
				throw signal.reason;
			});

			expect(
				(await outbox.flush({ signal: controller.signal })).map((entry) => entry.status)
			).toEqual(['unknown', 'pending']);
			expect(sender.send).toHaveBeenCalledTimes(1);
		}
	);

	test('remains conservative if a sender returns after ignoring cancellation', async () => {
		const { outbox, sender } = setup();
		await outbox.enqueue({ id: 'edit-1', payload: null });
		const controller = new AbortController();
		sender.send.mockImplementationOnce(() => {
			controller.abort();
			return Promise.resolve({ status: 'confirmed', receipt: 1 });
		});

		expect((await outbox.flush({ signal: controller.signal }))[0].status).toBe('unknown');
	});
});
