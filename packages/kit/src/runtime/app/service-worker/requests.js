import { has_data_suffix } from '../../../pathname.js';

/**
 * Classify Kit requests without exposing private endpoint conventions to plugins.
 * Classification says nothing about whether a response may be stored.
 * @param {{origin: string; base: string; appDir: string}} options
 * @returns {(request: Request) => import('./fallback.js').WorkerRequestInfo}
 */
export function create_request_classifier({ origin, base, appDir }) {
	return (request) => {
		const url = new URL(request.url);
		const other = /** @type {const} */ ({ kind: 'other', key: null });
		if (
			url.origin !== origin ||
			(base && url.pathname !== base && !url.pathname.startsWith(base + '/'))
		)
			return other;
		if (url.pathname.startsWith(`${base}/${appDir}/remote/`)) {
			if (
				request.method === 'GET' &&
				request.headers
					.get('accept')
					?.split(',')
					.some((type) => type.split(';')[0].trim().toLowerCase() === 'text/event-stream')
			) {
				return { kind: 'remote-live', key: null };
			}
			return request.method === 'GET'
				? { kind: 'remote-query', key: url.href }
				: request.method === 'HEAD'
					? other
					: { kind: 'remote-mutation', key: null };
		}
		if (request.method === 'POST' && request.headers.get('x-sveltekit-action') === 'true') {
			return { kind: 'action', key: null };
		}
		if (request.method === 'GET' && has_data_suffix(url.pathname))
			return { kind: 'data', key: url.href };
		return other;
	};
}
