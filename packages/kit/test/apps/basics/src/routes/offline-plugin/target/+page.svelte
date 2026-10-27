<script>
	/** @type {import('./$types').PageProps} */
	let { data } = $props();
</script>

<h1>{data.message}</h1>
<p id="source">{data.source}</p>
<p id="network">{data.network}</p>
<p id="layout-source">{data.layoutSource}</p>
<p id="layout-network">{data.layoutNetwork}</p>
<p id="parent-source">{data.parentSource}</p>
<p id="tracked">{data.tracked}</p>
<p id="path">{data.path}</p>
<p id="route">{data.routeId}</p>
