/**
 * @type {import('$app/service-worker').DataFallbackLoad}
 * @returns {import('../data.js').StreamingData}
 */
export function load() {
	return {
		eager: 'offline eager',
		streamed: new Promise((resolve) => {
			setTimeout(() => resolve('offline streamed'), 1000);
		}),
		failed: new Promise((_, reject) => {
			setTimeout(() => reject(new Error('offline rejected')), 1500);
		})
	};
}
