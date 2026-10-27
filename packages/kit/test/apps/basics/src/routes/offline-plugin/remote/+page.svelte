<script>
	import {
		offline_cached_items,
		offline_uncached_items,
		offline_write,
		offline_live_items
	} from './data.remote.js';

	let cached_status = $state('idle');
	let cached_value = $state(-1);
	let cached_attempts = $state(0);
	let uncached_status = $state('idle');
	let uncached_attempts = $state(0);
	let mutation_status = $state('idle');
	let mutation_value = $state(-1);
	let live_status = $state('idle');
	let live_values = $state('');

	async function read_cached() {
		cached_status = 'pending';
		try {
			const query = offline_cached_items();
			// Force a request so Kit's in-memory query cache cannot mask SW behaviour.
			await query.refresh();
			cached_value = (await query).value;
			cached_status = 'ready';
		} catch {
			cached_status = 'error';
		} finally {
			cached_attempts += 1;
		}
	}

	async function read_uncached() {
		uncached_status = 'pending';
		try {
			const query = offline_uncached_items();
			await query.refresh();
			await query;
			uncached_status = 'ready';
		} catch {
			uncached_status = 'error';
		} finally {
			uncached_attempts += 1;
		}
	}

	async function mutate() {
		mutation_status = 'pending';
		try {
			const result = await offline_write();
			mutation_value = result.value;
			mutation_status = result.state;
		} catch {
			mutation_status = 'error';
		}
	}

	async function read_live() {
		live_status = 'pending';
		live_values = '';
		try {
			for await (const value of offline_live_items()) {
				live_values += `${value}\n`;
			}
			live_status = 'done';
		} catch {
			live_status = 'error';
		}
	}
</script>

<h1>Remote cache policy</h1>

<button id="read-cached" onclick={read_cached}>Read cacheable query</button>
<p id="cached-status">{cached_status}</p>
<p id="cached-value">{cached_value}</p>
<p id="cached-attempts">{cached_attempts}</p>

<button id="read-uncached" onclick={read_uncached}>Read default query</button>
<p id="uncached-status">{uncached_status}</p>
<p id="uncached-attempts">{uncached_attempts}</p>

<button id="mutate" onclick={mutate}>Run command</button>
<p id="mutation-status">{mutation_status}</p>
<p id="mutation-value">{mutation_value}</p>

<button id="read-live" onclick={read_live}>Read live query</button>
<p id="live-status">{live_status}</p>
<pre id="live-values">{live_values}</pre>
