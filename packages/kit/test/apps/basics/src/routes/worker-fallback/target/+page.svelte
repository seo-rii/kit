<script>
	/** @type {import('./$types').PageProps} */
	let { data } = $props();
</script>

<h1>{data.message}</h1>
<p id="layout-source">{data.layoutSource}</p>
<p id="layout-network">{data.layoutNetwork}</p>
<p id="layout-seen">{data.layoutSeen}</p>
<p id="source">{data.source}</p>
<p id="path">{data.path}</p>
<p id="tracked">{data.tracked}</p>
<p id="stale">{String(data.stale)}</p>
{#if data.network}
	<p id="network">{data.network}</p>
{/if}
