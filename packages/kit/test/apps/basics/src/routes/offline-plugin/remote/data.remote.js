import { command, query } from '$app/server';

let writes = 0;

export const offline_cached_items = query(() => ({ value: writes, label: 'cacheable' }));

export const offline_uncached_items = query(() => ({ value: writes, label: 'no-store' }));

export const offline_write = command(() => ({ value: ++writes, state: 'confirmed' }));

export const offline_live_items = query.live(async function* () {
	yield 'first live value';
	await new Promise((resolve) => setTimeout(resolve, 100));
	yield 'second live value';
});
