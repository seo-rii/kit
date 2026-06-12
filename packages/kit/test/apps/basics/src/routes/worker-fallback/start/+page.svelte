<script>
	import { goto } from '$app/navigation';
</script>

<a href="/worker-fallback/target">target</a>
<button onclick={() => goto('/worker-fallback/target')}>target with goto</button>
