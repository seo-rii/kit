<script>
	/** @type {import('./$types').PageProps} */
	let { data } = $props();
</script>

<h1>{data.message}</h1>
<p id="source">{data.source}</p>
<p id="stale">{String(data.stale)}</p>
{#if data.network}
	<p id="network">{data.network}</p>
{/if}
