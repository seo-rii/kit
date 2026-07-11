/** @type {import('../.svelte-kit/types/src/core/sync/write_types/test/worker-fallbacks/worker-only/$worker-types').PageWorkerActions} */
export const actions = {
	queued: () => ({ queued: true }),
	rejected: () => ({
		type: 'failure',
		status: 503,
		data: { rejected: true }
	})
};
