export function load() {
	return {
		message: 'server data',
		source: 'server',
		stale: false
	};
}

export const actions = {
	serverOnly: () => ({ source: 'server-action' })
};
