/** @type {import('./$worker-types').PageWorkerLoad} */
export function load() {
	return {
		eager: 'worker eager',
		streamed: new Promise((resolve) => {
			setTimeout(() => {
				resolve('worker streamed');
			}, 1000);
		}),
		failed: new Promise((_, reject) => {
			setTimeout(() => {
				reject(new Error('worker rejected'));
			}, 1500);
		})
	};
}
