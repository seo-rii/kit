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
