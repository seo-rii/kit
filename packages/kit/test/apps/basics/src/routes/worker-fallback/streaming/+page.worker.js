/** @type {import('./$types').PageWorkerLoad} */
export function load() {
	return {
		eager: 'worker eager',
		streamed: new Promise((resolve) => {
			setTimeout(() => {
				resolve('worker streamed');
			}, 100);
		}),
		failed: new Promise((_, reject) => {
			setTimeout(() => {
				reject(new Error('worker rejected'));
			}, 150);
		})
	};
}
