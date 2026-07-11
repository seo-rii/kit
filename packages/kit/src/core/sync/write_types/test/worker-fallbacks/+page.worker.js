/** @type {import('./.svelte-kit/types/src/core/sync/write_types/test/worker-fallbacks/$worker-types').PageWorkerLoad} */
export async function load({ parent }) {
	const data = await parent();
	data.layoutWorker;
	// @ts-expect-error server layout data is not available to a worker parent
	data.layoutServer;

	return {
		pageWorker: 'worker page'
	};
}

/** @type {import('./.svelte-kit/types/src/core/sync/write_types/test/worker-fallbacks/$worker-types').PageWorkerActions} */
export const actions = {
	workerSuccess: () => ({ workerSuccess: true }),
	workerResult: () => ({
		type: 'success',
		status: 200,
		data: { workerResult: true }
	}),
	workerFailure: () => ({
		type: 'failure',
		status: 503,
		data: { workerFailure: true }
	}),
	workerRedirect: () => ({
		type: 'redirect',
		status: 303,
		location: '/elsewhere'
	}),
	workerError: () => ({
		type: 'error',
		status: 500,
		error: { message: 'broken' }
	}),
	plainResultLikeData: () => ({
		type: 'error',
		status: 200,
		message: 'plain success data'
	})
};
