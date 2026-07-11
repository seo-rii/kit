<script>
	/** @type {import('./$types').PageProps} */
	let { data } = $props();
</script>

<h1>{data.source}</h1>
<p id="route">{data.route}</p>
