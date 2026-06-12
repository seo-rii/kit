export function load() {
	return {
		eager: 'server eager',
		streamed: Promise.resolve('server streamed')
	};
}
