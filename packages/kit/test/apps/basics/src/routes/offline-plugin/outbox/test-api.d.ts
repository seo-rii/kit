import type { JsonValue, OutboxEntry } from 'sveltekit-offline/outbox';

interface OutboxTestApi {
	enqueue(id: string, payload: JsonValue): Promise<OutboxEntry>;
	list(): Promise<OutboxEntry[]>;
	flush(options?: { retryUnknown?: boolean }): Promise<OutboxEntry[]>;
	stats(id: string): Promise<{ effects: number; requests: number }>;
	setLoss(enabled: boolean): void;
	pauseSender(): void;
	resumeSender(): void;
	readonly senderCalls: number;
}

declare global {
	interface Window {
		offline_outbox: OutboxTestApi;
	}
}

export {};
