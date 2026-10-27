/** @import { OutboxStore } from './outbox-public.js' */

/**
 * Open persistent outbox storage, partitioned by stable application/user scope.
 * @param {{ name?: string; indexedDB?: IDBFactory }} [options]
 * @returns {Promise<OutboxStore>}
 */
export async function createIndexedDBOutboxStore({
	name = 'sveltekit-offline-outbox',
	indexedDB: indexed_db = globalThis.indexedDB
} = {}) {
	if (!indexed_db) throw new Error('IndexedDB is unavailable');
	if (typeof name !== 'string' || !name)
		throw new TypeError('An IndexedDB database name is required');

	const database = await new Promise((resolve, reject) => {
		const request = indexed_db.open(name, 1);
		let blocked = false;
		request.onblocked = () => {
			blocked = true;
			reject(new Error('Opening the outbox database is blocked by another connection'));
		};
		request.onupgradeneeded = () => {
			if (blocked) {
				request.transaction?.abort();
				return;
			}
			const store = request.result.createObjectStore('operations', { keyPath: ['scope', 'id'] });
			store.createIndex('scope', 'scope');
		};
		request.onerror = () => reject(request.error);
		request.onsuccess = () => {
			const database = request.result;
			if (blocked) {
				database.close();
				return;
			}
			database.onversionchange = () => database.close();
			resolve(database);
		};
	});

	/**
	 * @template T
	 * @param {IDBTransactionMode} mode
	 * @param {(store: IDBObjectStore) => IDBRequest<T>} run
	 * @returns {Promise<T>}
	 */
	function transaction(mode, run) {
		return new Promise((resolve, reject) => {
			const transaction = database.transaction('operations', mode, {
				durability: mode === 'readwrite' ? 'strict' : 'default'
			});
			const request = run(transaction.objectStore('operations'));
			/** @type {T} */
			let result;
			request.onsuccess = () => {
				result = request.result;
			};
			transaction.oncomplete = () => resolve(result);
			transaction.onabort = () =>
				reject(transaction.error ?? new Error('Outbox transaction aborted'));
		});
	}

	return {
		name,
		async get(scope, id) {
			return (await transaction('readonly', (store) => store.get([scope, id]))) ?? null;
		},
		list(scope) {
			return transaction('readonly', (store) => store.index('scope').getAll(scope));
		},
		async put(entry) {
			await transaction('readwrite', (store) => store.put(entry));
		},
		close() {
			database.close();
		}
	};
}
