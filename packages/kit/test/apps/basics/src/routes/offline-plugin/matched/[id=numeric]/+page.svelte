<script>
	/** @type {import('./$types').PageProps} */
	let { data } = $props();
</script>

<h1>{data.match}</h1>
<p id="source">{data.source}</p>
<p id="value">{data.value}</p>
<p id="value-type">{data.valueType}</p>
<p id="route">{data.routeId}</p>
