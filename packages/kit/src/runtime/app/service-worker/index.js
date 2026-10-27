/// <reference no-default-lib="true"/>
/// <reference lib="esnext" />
/// <reference lib="webworker" />

import { DEV } from 'esm-env';
import * as e from '../../../messages/shared-errors.js';
import {
	resolveData as resolve_data,
	classifyRequest as classify_request
} from '<sveltekit:generated>/service-worker-data.js';

/** @param {Request} request @returns {import('./fallback.js').WorkerRequestInfo} */
export function classifyRequest(request) {
	return classify_request(request);
}

/**
 * Produce a Kit data response from explicitly registered browser-safe loads.
 * @param {Request} request
 * @param {import('./fallback.js').DataFallbackHandlers} handlers
 * @returns {Promise<Response | null>}
 */
export function resolveData(request, handlers) {
	return resolve_data(request, handlers);
}

/**
 * The execution context of a service worker. This export exists to make it easier to
 * use service workers with the correct types, provided the importing module is governed
 * by a `tsconfig.json` that extends [`$app/tsconfig/service-worker`](https://svelte.dev/docs/kit/$app-tsconfig-service-worker).
 *
 */
export const self = /** @type {ServiceWorkerGlobalScope} */ (
	/** @type {unknown} */ (globalThis.self)
);

if (DEV) {
	if (
		typeof ServiceWorkerGlobalScope === 'undefined' ||
		!(self instanceof ServiceWorkerGlobalScope)
	) {
		e.service_worker_module_outside_worker();
	}
}
