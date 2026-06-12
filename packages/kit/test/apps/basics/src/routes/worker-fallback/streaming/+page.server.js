export function load() {
	return {
		eager: 'server eager',
		streamed: Promise.resolve('server streamed'),
		failed: Promise.resolve('server recovered')
	};
}
