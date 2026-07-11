import { fail } from '../../../../../../src/exports/index.js';

export function load() {
	return {
		pageServer: 'server page'
	};
}

export const actions = {
	serverSuccess: () => ({ serverSuccess: true }),
	serverFailure: () => fail(400, { serverFailure: true })
};
