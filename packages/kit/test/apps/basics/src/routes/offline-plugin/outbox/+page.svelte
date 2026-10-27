<script>
	import { onMount } from 'svelte';
	import { createIndexedDBOutboxStore, createOutbox } from 'sveltekit-offline/outbox';

	let ready = $state(false);
	let failure = $state('');

	onMount(() => {
		let active = true;
		/** @type {import('sveltekit-offline/outbox').OutboxStore | undefined} */
		let store;
		let lose_response = false;
		let sender_calls = 0;
		let gate = Promise.resolve();
		/** @type {() => void} */
		let release = () => {};

		async function initialize() {
			try {
				const params = new URL(location.href).searchParams;
				const scope = params.get('scope') ?? 'test-user';
				const opened = await createIndexedDBOutboxStore({
					name: params.get('db') ?? 'offline-outbox-browser-test'
				});
				if (!active) {
					opened.close?.();
					return;
				}
				store = opened;
				const outbox = createOutbox({
					scope,
					store,
					sender: {
						idempotency: 'operation-id',
						async send({ scope, id, payload, signal }) {
							sender_calls += 1;
							await gate;
							const response = await fetch('/offline-plugin/outbox/submit', {
								method: 'POST',
								headers: {
									'content-type': 'application/json',
									'x-outbox-test-lose-response': String(lose_response)
								},
								body: JSON.stringify({ scope, id, payload }),
								signal
							});
							if (!response.ok && response.status !== 409) {
								throw new TypeError('No explicit mutation receipt');
							}
							const receipt = await response.json();
							if (response.headers.get('x-outbox-test-drop-response') === '1') {
								// The server really committed; deliberately discard its first receipt.
								throw new TypeError('Simulated response loss after server commit');
							}
							return receipt;
						}
					}
				});

				window.offline_outbox = {
					enqueue: (id, payload) => outbox.enqueue({ id, payload }),
					list: () => outbox.list(),
					flush: (options) => outbox.flush(options),
					async stats(id) {
						const params = new URLSearchParams({ scope, id });
						const response = await fetch(`/offline-plugin/outbox/submit?${params}`);
						return response.json();
					},
					setLoss(enabled) {
						lose_response = enabled;
					},
					pauseSender() {
						gate = new Promise((resolve) => {
							release = resolve;
						});
					},
					resumeSender() {
						release();
					},
					get senderCalls() {
						return sender_calls;
					}
				};
				ready = true;
			} catch (error) {
				failure = error instanceof Error ? error.message : String(error);
			}
		}

		void initialize();
		return () => {
			active = false;
			release();
			store?.close?.();
		};
	});
</script>

<h1>Explicit offline mutation outbox</h1>
<p id="outbox-ready">{ready ? 'ready' : 'opening'}</p>
{#if failure}<p id="outbox-failure">{failure}</p>{/if}
