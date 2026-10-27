import { fail } from '@sveltejs/kit';

export function load() {
	return {
		pageServer: 'server page'
	};
}

export const actions = {
	serverSuccess: () => ({ serverSuccess: true }),
	serverFailure: () => fail(400, { serverFailure: true })
};
