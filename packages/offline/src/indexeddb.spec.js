/** @import { OutboxEntry } from './outbox-public.js' */
import { expect, test, vi } from 'vitest';
import { createIndexedDBOutboxStore } from './indexeddb.js';

/**
 * @typedef {{ result: undefined; onsuccess: () => void }} TestRequest
 * @typedef {{ objectStore: () => { put: () => TestRequest }; error: DOMException | null;
 * request: TestRequest; oncomplete: () => void; onabort: () => void }} TestTransaction
 */

function indexeddb() {
	/** @type {TestTransaction[]} */
	const transactions = [];
	const database = {
		close: vi.fn(),
		transaction: vi.fn(() => {
			const request = { result: undefined, onsuccess: () => {} };
			/** @type {TestTransaction} */
			const transaction = {
				objectStore: () => ({ put: () => request }),
				error: null,
				request,
				oncomplete: () => {},
				onabort: () => {}
			};
			transactions.push(transaction);
			return transaction;
		})
	};
	const opening = { result: database, onsuccess: () => {}, onblocked: () => {} };
	// Deliberately model only the IndexedDB events whose durability is under test.
	const factory = /** @type {IDBFactory} */ (
		/** @type {unknown} */ ({ open: vi.fn(() => opening) })
	);
	return { transactions, database, opening, factory };
}

/** @type {OutboxEntry} */
const entry = { scope: 'user-a', id: 'edit-1', payload: null, status: 'pending', attempts: 0 };

test('does not report durability until the IndexedDB transaction completes', async () => {
	const { factory, opening, database, transactions } = indexeddb();
	const pending_store = createIndexedDBOutboxStore({ indexedDB: factory });
	opening.onsuccess();
	const store = await pending_store;
	let settled = false;
	const pending_write = store.put(entry).then(() => {
		settled = true;
	});
	const transaction = transactions[0];
	transaction.request.onsuccess();
	await Promise.resolve();

	expect(settled).toBe(false);
	expect(database.transaction).toHaveBeenCalledWith('operations', 'readwrite', {
		durability: 'strict'
	});
	transaction.oncomplete();
	await pending_write;
	expect(settled).toBe(true);
});

test('rejects a transaction abort even after the write request succeeds', async () => {
	const { factory, opening, transactions } = indexeddb();
	const pending_store = createIndexedDBOutboxStore({ indexedDB: factory });
	opening.onsuccess();
	const store = await pending_store;
	const error = new DOMException('Transaction could not commit', 'QuotaExceededError');
	const pending_write = store.put(entry);
	const rejected = expect(pending_write).rejects.toBe(error);
	const transaction = transactions[0];
	transaction.request.onsuccess();
	transaction.error = error;
	transaction.onabort();
	await rejected;
});

test('closes a connection that eventually opens after reporting it blocked', async () => {
	const { factory, opening, database } = indexeddb();
	const pending_store = createIndexedDBOutboxStore({ indexedDB: factory });
	const rejected = expect(pending_store).rejects.toThrow('blocked');
	opening.onblocked();
	await rejected;
	opening.onsuccess();
	expect(database.close).toHaveBeenCalledTimes(1);
});
