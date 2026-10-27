/** @type {import('./$worker-types').PageWorkerActions} */
export const actions = {
	queued: () => ({ queued: true }),
	rejected: () => ({
		type: 'failure',
		status: 503,
		data: { rejected: true }
	})
};
