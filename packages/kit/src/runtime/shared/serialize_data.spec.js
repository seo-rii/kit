/** @import { ServerDataNode } from 'types' */
import { expect, test, vi } from 'vitest';
import * as devalue from 'devalue';
import { create_data_serializer } from './serialize_data.js';

/** @param {Partial<Parameters<typeof create_data_serializer>[0]>} [options] */
function serializer(options = {}) {
	return create_data_serializer({
		encoders: {},
		onError: () => ({ message: 'Internal Error' }),
		onSerializationError: (error) => error,
		...options
	});
}

/**
 * @param {Record<string, any> | null} data
 * @param {Partial<ServerDataNode>} [overrides]
 * @returns {ServerDataNode}
 */
function node(data, overrides = {}) {
	return {
		type: 'data',
		data,
		uses: {
			dependencies: new Set(),
			params: new Set(),
			search_params: new Set(),
			parent: false,
			route: false,
			url: false
		},
		...overrides
	};
}

test('preserves node positions, metadata and the newline-delimited response format', () => {
	const result = serializer();
	result.add_node(4, node({ answer: 42 }));
	result.add_node(0, null);
	result.add_node(1, undefined);
	result.add_node(2, { type: 'skip' });
	result.add_node(3, { type: 'error', error: { status: 404, message: 'Not found' } });
	result.add_node(
		5,
		node(null, {
			slash: 'always',
			uses: {
				dependencies: new Set(['https://example.com/data']),
				params: new Set(['slug']),
				search_params: new Set(['filter']),
				parent: true,
				route: true,
				url: true
			}
		})
	);

	expect(result.get_data()).toEqual({
		data: '{"type":"data","nodes":[null,null,{"type":"skip"},{"type":"error","error":{"status":404,"message":"Not found"}},{"type":"data","data":[{"answer":1},42],"uses":{}},{"type":"data","data":[null],"uses":{"dependencies":["https://example.com/data"],"search_params":["filter"],"params":["slug"],"parent":1,"route":1,"url":1},"slash":"always"}]}\n',
		chunks: null
	});
});

test('preserves built-in values and circular data', () => {
	const result = serializer();
	/** @type {Record<string, any>} */
	const data = {
		date: new Date('2026-10-26T00:00:00Z'),
		map: new Map([['key', new Set([1, 2])]]),
		bigint: 123n
	};
	data.self = data;
	result.add_node(0, node(data));

	const decoded = devalue.unflatten(JSON.parse(result.get_data().data).nodes[0].data);
	expect(decoded).toEqual(data);
	expect(decoded.self).toBe(decoded);
});

test('streams promises in settlement order, including promises discovered in chunks', async () => {
	const result = serializer();
	const slow = Promise.withResolvers();
	const fast = Promise.withResolvers();
	const nested = Promise.withResolvers();
	result.add_node(0, node({ slow: slow.promise, fast: fast.promise }));

	const { data, chunks } = result.get_data();
	const pending = devalue.unflatten(JSON.parse(data).nodes[0].data, {
		Promise: (id) => ({ id })
	});
	expect(pending).toEqual({ slow: { id: 1 }, fast: { id: 2 } });

	const iterator = /** @type {AsyncIterable<string>} */ (chunks)[Symbol.asyncIterator]();
	fast.resolve({ nested: nested.promise });
	const first = JSON.parse((await iterator.next()).value);
	expect(first).toMatchObject({ type: 'chunk', id: 2 });
	expect(devalue.unflatten(first.data, { Promise: (id) => ({ id }) })).toEqual({
		nested: { id: 3 }
	});

	nested.resolve('nested result');
	const second = JSON.parse((await iterator.next()).value);
	expect(second).toMatchObject({ type: 'chunk', id: 3 });
	expect(devalue.unflatten(second.data)).toBe('nested result');

	slow.resolve('slow result');
	const third = JSON.parse((await iterator.next()).value);
	expect(third).toMatchObject({ type: 'chunk', id: 1 });
	expect(devalue.unflatten(third.data)).toBe('slow result');
	expect(await iterator.next()).toEqual({ done: true, value: undefined });
});

test('uses the same custom transport for initial data and streamed values', async () => {
	class Money {
		/** @param {number} cents */
		constructor(cents) {
			this.cents = cents;
		}
	}

	const result = serializer({
		encoders: { Money: (value) => value instanceof Money && [value.cents] }
	});
	result.add_node(0, node({ initial: new Money(250), later: Promise.resolve(new Money(500)) }));
	const { data, chunks } = result.get_data();
	const initial = devalue.unflatten(JSON.parse(data).nodes[0].data, {
		Money: ([cents]) => new Money(cents),
		Promise: (id) => ({ id })
	});
	expect(initial.initial).toEqual(new Money(250));
	expect(initial.initial).toBeInstanceOf(Money);

	const streamed = [];
	for await (const chunk of /** @type {AsyncIterable<string>} */ (chunks)) {
		streamed.push(
			devalue.unflatten(JSON.parse(chunk).data, { Money: ([cents]) => new Money(cents) })
		);
	}
	expect(streamed).toEqual([new Money(500)]);
	expect(streamed[0]).toBeInstanceOf(Money);
});

test('passes rejected promises through asynchronous error handling', async () => {
	const failure = new Error('private detail');
	const onError = vi.fn(() => Promise.resolve({ status: 500, message: 'Public message' }));
	const onSerializationError = vi.fn((error) => error);
	const result = serializer({ onError, onSerializationError });
	result.add_node(0, node({ later: Promise.reject(failure) }));

	const chunks = [];
	for await (const chunk of /** @type {AsyncIterable<string>} */ (result.get_data().chunks)) {
		chunks.push(JSON.parse(chunk));
	}
	expect(onError).toHaveBeenCalledExactlyOnceWith(failure);
	expect(onSerializationError).not.toHaveBeenCalled();
	expect(chunks).toHaveLength(1);
	expect(chunks[0]).toMatchObject({ type: 'chunk', id: 1 });
	expect(devalue.unflatten(chunks[0].error)).toEqual({ status: 500, message: 'Public message' });
	expect(chunks[0]).not.toHaveProperty('data');
});

test('reports initial serialization failures synchronously with their data path', () => {
	const failure = new Error('Cannot serialize this node');
	const onSerializationError = vi.fn(() => failure);
	const onError = vi.fn();
	const result = serializer({ onError, onSerializationError });

	expect(() => result.add_node(0, node({ invalid: () => {} }))).toThrow(failure);
	expect(onSerializationError).toHaveBeenCalledExactlyOnceWith(
		expect.objectContaining({ path: '.invalid' }),
		false
	);
	expect(onError).not.toHaveBeenCalled();
});

test('converts unserializable deferred values into error chunks', async () => {
	const failure = new Error('Cannot serialize this promise');
	const onSerializationError = vi.fn(() => failure);
	const onError = vi.fn(() => Promise.resolve({ status: 500, message: 'Public message' }));
	const result = serializer({ onError, onSerializationError });
	result.add_node(0, node({ later: Promise.resolve({ invalid: () => {} }) }));

	const chunks = [];
	for await (const chunk of /** @type {AsyncIterable<string>} */ (result.get_data().chunks)) {
		chunks.push(JSON.parse(chunk));
	}
	expect(onSerializationError).toHaveBeenCalledExactlyOnceWith(
		expect.objectContaining({ path: '.invalid' }),
		true
	);
	expect(onError).toHaveBeenCalledExactlyOnceWith(failure);
	expect(chunks).toHaveLength(1);
	expect(chunks[0]).toMatchObject({ type: 'chunk', id: 1 });
	expect(devalue.unflatten(chunks[0].error)).toEqual({ status: 500, message: 'Public message' });
});
