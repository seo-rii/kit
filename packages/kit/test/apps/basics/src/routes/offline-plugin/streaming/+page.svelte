<script>
	/** @type {import('./$types').PageProps} */
	let { data } = $props();
</script>

<h1>Streaming fallback</h1>
<p id="eager">{data.eager}</p>

{#await data.streamed}
	<p id="stream-loading">Waiting for data</p>
{:then value}
	<p id="streamed">{value}</p>
{/await}

{#await data.failed}
	<p id="failure-loading">Waiting for failure</p>
{:then value}
	<p id="recovered">{value}</p>
{:catch error}
	<p id="failed">{error.message}</p>
{/await}
