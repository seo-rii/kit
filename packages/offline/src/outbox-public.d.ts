/** A value that can be stored and sent without changing JSON semantics. */
export type JsonValue =
	| null
	| boolean
	| number
	| string
	| JsonValue[]
	| { [key: string]: JsonValue };

interface Operation {
	/** Stable application/user identity, also used by the server's deduplication. */
	scope: string;
	/** Stable operation identity. Retrying must keep this ID and payload. */
	id: string;
	payload: JsonValue;
	/** Number of attempts durably recorded before invoking the sender. */
	attempts: number;
}

export type OutboxEntry = Operation &
	(
		| { status: 'pending' | 'unknown' }
		| { status: 'confirmed'; receipt: JsonValue }
		| { status: 'rejected'; reason: JsonValue }
	);

export interface OutboxStore {
	/** Stable storage namespace shared by every tab/worker using this store. */
	name: string;
	get(scope: string, id: string): Promise<OutboxEntry | null>;
	list(scope: string): Promise<OutboxEntry[]>;
	/** Resolve only after the complete write transaction commits. */
	put(entry: OutboxEntry): Promise<void>;
	close?(): void;
}

/** A lock must serialize the same name across every context sharing the store. */
export type OutboxLock = <T>(
	name: string,
	run: () => Promise<T>,
	signal?: AbortSignal
) => Promise<T>;

export interface OutboxSubmission {
	scope: string;
	id: string;
	payload: JsonValue;
	signal?: AbortSignal;
}

export type OutboxReceipt =
	| { status: 'confirmed'; receipt: JsonValue }
	| { status: 'rejected'; reason: JsonValue };

export interface OutboxOptions {
	/** Create a separate outbox when the signed-in user's stable identity changes. */
	scope: string;
	store: OutboxStore;
	sender: {
		/**
		 * Explicit application contract: the server atomically deduplicates writes by
		 * authenticated scope and operation ID, rejects payload changes, and returns
		 * the original receipt on a retry. This package cannot enforce that contract
		 * or provide exactly-once delivery on its own.
		 */
		idempotency: 'operation-id';
		send(operation: OutboxSubmission): Promise<OutboxReceipt>;
	};
	/** Defaults to Web Locks. An unsafe unlocked fallback is never used. */
	lock?: OutboxLock;
}

export interface Outbox {
	/**
	 * Durably record an explicit mutation without sending it. Reusing an ID with
	 * identical JSON returns the existing entry; different JSON is rejected.
	 */
	enqueue(operation: { id: string; payload: JsonValue }): Promise<OutboxEntry>;
	/** List only the fixed scope's entries, including attempts still in progress. */
	list(): Promise<OutboxEntry[]>;
	/**
	 * Send pending entries under the store/scope lock. An attempt is persisted as
	 * unknown before transmission; only a persisted explicit receipt confirms it.
	 * Network failures and cancellation leave it unknown. The sender must honor
	 * the signal so cancellation can finish promptly.
	 *
	 * Unknown entries require explicit retryUnknown: true and the declared server
	 * idempotency contract. Concurrent calls on this instance share the first
	 * call's options/result. Storage failures reject; inspect list() to recover.
	 */
	flush(options?: { retryUnknown?: boolean; signal?: AbortSignal }): Promise<OutboxEntry[]>;
}

/**
 * Create an explicit mutation outbox. This does not intercept forms, remote
 * functions, fetch requests, or authentication changes.
 */
export function createOutbox(options: OutboxOptions): Outbox;

/**
 * Open the IndexedDB outbox store. Writes use strict transaction durability and
 * resolve on transaction completion, never just an individual request's success.
 */
export function createIndexedDBOutboxStore(options?: {
	name?: string;
	indexedDB?: IDBFactory;
}): Promise<OutboxStore>;
