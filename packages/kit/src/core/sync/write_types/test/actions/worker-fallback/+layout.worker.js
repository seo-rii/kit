/** @type {import('./$worker-types').LayoutWorkerLoad} */
export function load() {
	// @ts-expect-error route workers do not run with DOM globals
	document.title = 'offline';

	return {
		layoutWorker: 'worker layout'
	};
}
