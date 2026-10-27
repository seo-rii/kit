/** @import { ServerDataNode, ServerDataSkippedNode, ServerErrorNode } from 'types' */
import * as devalue from 'devalue';
import { create_async_iterator } from '../../utils/streaming.js';

/**
 * Serializes data responses in any runtime. The caller supplies error handling so
 * that the wire format does not depend on server request state.
 *
 * `onSerializationError` transforms a serialization failure into an error (or
 * throws it). Initial node failures are thrown synchronously; failures in a
 * deferred value are passed through `onError` and sent as error chunks.
 *
 * @param {{
 *   encoders: Record<string, (value: any) => any>;
 *   onError: (error: unknown) => unknown | Promise<unknown>;
 *   onSerializationError: (error: any, streamed: boolean) => unknown;
 * }} options
 * @returns {{
 *   add_node: (i: number, node: ServerDataSkippedNode | ServerDataNode | ServerErrorNode | null | undefined) => void;
 *   get_data: () => { data: string; chunks: AsyncIterable<string> | null };
 * }}
 */
export function create_data_serializer({ encoders, onError, onSerializationError }) {
	let promise_id = 1;

	const iterator = create_async_iterator();

	const reducers = {
		...encoders,
		/** @param {any} thing */
		Promise: (thing) => {
			if (typeof thing?.then !== 'function') {
				return;
			}

			const id = promise_id++;

			/** @type {'data' | 'error'} */
			let key = 'data';

			const promise = thing
				.catch(
					/** @param {any} error */ (error) => {
						key = 'error';
						return onError(error);
					}
				)
				.then(
					/** @param {any} value */
					async (value) => {
						let str;
						try {
							str = devalue.stringify(value, reducers);
						} catch (serialization_error) {
							const error = await onError(onSerializationError(serialization_error, true));

							key = 'error';
							str = devalue.stringify(error, reducers);
						}

						return `{"type":"chunk","id":${id},"${key}":${str}}\n`;
					}
				);

			iterator.add(promise);

			return id;
		}
	};

	const strings = /** @type {string[]} */ ([]);

	return {
		add_node(i, node) {
			try {
				if (!node) {
					strings[i] = 'null';
					return;
				}

				if (node.type === 'error' || node.type === 'skip') {
					strings[i] = JSON.stringify(node);
					return;
				}

				strings[i] =
					`{"type":"data","data":${devalue.stringify(node.data, reducers)},"uses":${JSON.stringify(
						serialize_uses(node)
					)}${node.slash ? `,"slash":${JSON.stringify(node.slash)}` : ''}}`;
			} catch (error) {
				throw onSerializationError(error, false);
			}
		},

		get_data() {
			return {
				data: `{"type":"data","nodes":[${strings.join(',')}]}\n`,
				chunks: promise_id > 1 ? iterator.iterate() : null
			};
		}
	};
}

/** @param {ServerDataNode} node */
export function serialize_uses(node) {
	const uses = {};

	if (node.uses && node.uses.dependencies.size > 0) {
		uses.dependencies = Array.from(node.uses.dependencies);
	}

	if (node.uses && node.uses.search_params.size > 0) {
		uses.search_params = Array.from(node.uses.search_params);
	}

	if (node.uses && node.uses.params.size > 0) {
		uses.params = Array.from(node.uses.params);
	}

	if (node.uses?.parent) uses.parent = 1;
	if (node.uses?.route) uses.route = 1;
	if (node.uses?.url) uses.url = 1;

	return uses;
}
