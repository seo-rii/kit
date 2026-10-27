<script>
	/** @type {import('./$types').PageProps} */
	let { data } = $props();
</script>

<h1>Rerouted data</h1>
<p id="source">{data.source}</p>
<p id="route">{data.routeId}</p>
<p id="pathname">{data.pathname}</p>
