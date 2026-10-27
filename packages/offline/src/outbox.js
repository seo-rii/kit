/** @import { JsonValue, Outbox, OutboxEntry, OutboxLock, OutboxOptions } from './outbox-public.js' */

export { createIndexedDBOutboxStore } from './indexeddb.js';

/**
 * Create an explicitly enqueued, scoped mutation outbox.
 *
 * The sender's server must deduplicate by authenticated scope and operation ID.
 * An unknown outcome is never replayed unless the caller requests it. Nothing
 * here captures or replays SvelteKit action or remote-function requests.
 *
 * @param {OutboxOptions} options
 * @returns {Outbox}
 */
export function createOutbox({ scope, store, sender, lock = web_lock }) {
	if (typeof scope !== 'string' || !scope) throw new TypeError('Outbox scope is required');
	if (typeof store.name !== 'string' || !store.name) {
		throw new TypeError('Outbox store needs a stable name for cross-context locking');
	}
	if (sender.idempotency !== 'operation-id') {
		throw new TypeError('Outbox sender must declare server idempotency by operation ID');
	}

	const lock_name = `sveltekit-offline-outbox:${JSON.stringify([store.name, scope])}`;
	/** @type {Promise<OutboxEntry[]> | undefined} */
	let flushing;

	return {
		async enqueue({ id, payload }) {
			if (typeof id !== 'string' || !id) throw new TypeError('Operation ID is required');
			const encoded = canonical_json(payload);
			return lock(lock_name, async () => {
				const existing = await store.get(scope, id);
				if (existing) {
					if (canonical_json(existing.payload) !== encoded) {
						throw new Error('Operation ID is already associated with a different payload');
					}
					return clone(existing);
				}

				/** @type {OutboxEntry} */
				const entry = { scope, id, payload: JSON.parse(encoded), status: 'pending', attempts: 0 };
				await store.put(entry);
				return clone(entry);
			});
		},

		async list() {
			return clone(await store.list(scope));
		},

		flush({ retryUnknown = false, signal } = {}) {
			if (signal?.aborted) return Promise.reject(signal.reason);
			if (flushing) return flushing;

			const result = lock(
				lock_name,
				async () => {
					signal?.throwIfAborted();
					const entries = await store.list(scope);
					for (let i = 0; i < entries.length; i += 1) {
						if (signal?.aborted) break;
						const entry = entries[i];
						if (entry.status !== 'pending' && !(retryUnknown && entry.status === 'unknown')) {
							continue;
						}

						// A crash, lost response, or aborted request may still commit on the server.
						// Persist uncertainty before sending, so restart cannot silently replay it.
						/** @type {OutboxEntry} */
						const unknown = { ...entry, status: 'unknown', attempts: entry.attempts + 1 };
						await store.put(unknown);
						entries[i] = unknown;
						if (signal?.aborted) break;

						let receipt;
						try {
							receipt = await sender.send({
								scope,
								id: entry.id,
								payload: clone(entry.payload),
								signal
							});
						} catch {
							continue;
						}
						if (signal?.aborted) break;

						/** @type {OutboxEntry} */
						let settled;
						if (receipt?.status === 'confirmed') {
							settled = {
								...unknown,
								status: 'confirmed',
								receipt: JSON.parse(canonical_json(receipt.receipt))
							};
						} else if (receipt?.status === 'rejected') {
							settled = {
								...unknown,
								status: 'rejected',
								reason: JSON.parse(canonical_json(receipt.reason))
							};
						} else {
							throw new TypeError(
								'Outbox sender must return an explicit confirmation or rejection'
							);
						}

						// If persisting the receipt fails, durable state remains unknown.
						await store.put(settled);
						entries[i] = settled;
					}
					return clone(entries);
				},
				signal
			);
			flushing = result;
			void result.then(
				() => {
					flushing = undefined;
				},
				() => {
					flushing = undefined;
				}
			);
			return result;
		}
	};
}

/** @type {OutboxLock} */
function web_lock(name, run, signal) {
	const locks = globalThis.navigator?.locks;
	if (!locks) {
		return Promise.reject(new Error('Outbox requires Web Locks or an injected cross-context lock'));
	}
	return locks.request(name, { signal }, run);
}

/**
 * @template T
 * @param {T} value
 * @returns {T}
 */
function clone(value) {
	return JSON.parse(JSON.stringify(value));
}

/**
 * Validate JSON and canonicalize object-key order so ID reuse cannot alter a
 * payload, even if the caller mutates the original object after enqueuing.
 * @param {JsonValue} value
 * @param {Set<object>} [seen]
 * @returns {string}
 */
function canonical_json(value, seen = new Set()) {
	if (value === null || typeof value === 'string' || typeof value === 'boolean') {
		return JSON.stringify(value);
	}
	if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
	if (typeof value !== 'object' || !value || seen.has(value)) {
		throw new TypeError('Outbox payloads and receipts must be finite, acyclic JSON values');
	}
	if (Object.getOwnPropertySymbols(value).length) {
		throw new TypeError('Outbox payloads and receipts must be JSON values');
	}

	seen.add(value);
	try {
		if (Array.isArray(value)) {
			const items = [];
			for (let i = 0; i < value.length; i += 1) {
				if (!Object.hasOwn(value, i)) throw new TypeError('Outbox JSON arrays cannot have holes');
				items.push(canonical_json(value[i], seen));
			}
			return `[${items.join(',')}]`;
		}
		const prototype = Object.getPrototypeOf(value);
		if (prototype !== Object.prototype && prototype !== null) {
			throw new TypeError('Outbox payloads and receipts must contain only plain JSON objects');
		}
		return `{${Object.keys(value)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${canonical_json(value[key], seen)}`)
			.join(',')}}`;
	} finally {
		seen.delete(value);
	}
}
