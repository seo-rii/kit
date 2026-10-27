<script>
	/** @type {import('./$types').PageProps} */
	let { data } = $props();
</script>

<p class="eager">{data.eager}</p>

{#await data.streamed}
	<p class="loading">Loading streamed worker data</p>
{:then streamed}
	<p class="streamed">{streamed}</p>
{/await}

{#await data.failed}
	<p class="failed-loading">Loading failed worker data</p>
{:then failed}
	<p class="failed">{failed}</p>
{:catch error}
	<p class="failed-error">{error.message}</p>
{/await}
