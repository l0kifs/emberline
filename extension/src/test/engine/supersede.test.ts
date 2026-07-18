/** Ported from server/tests/test_engine.py::TestSupersede, plus mutex fairness. */

import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Mutex, Supersede } from '../../engine/supersede';

describe('supersede', () => {
	it('makes an older claim stale', () => {
		const s = new Supersede();
		const first = s.claim('doc');
		assert.equal(s.isStale('doc', first), false);
		const second = s.claim('doc');
		assert.equal(s.isStale('doc', first), true);
		assert.equal(s.isStale('doc', second), false);
	});

	it('keeps sessions independent', () => {
		// The bug this guards: a global counter means two editors abort each other.
		const s = new Supersede();
		const a = s.claim('docA');
		const b = s.claim('docB');
		assert.equal(s.isStale('docA', a), false);
		assert.equal(s.isStale('docB', b), false);
	});

	it('resets on forget', () => {
		const s = new Supersede();
		const gen = s.claim('doc');
		s.forget('doc');
		assert.equal(s.isStale('doc', gen), true);
	});
});

describe('model lock', () => {
	it('serializes holders', async () => {
		const m = new Mutex();
		const order: string[] = [];
		const hold = async (name: string) =>
			m.runExclusive(async () => {
				order.push(`${name}:in`);
				await new Promise((r) => setTimeout(r, 5));
				order.push(`${name}:out`);
			});
		await Promise.all([hold('a'), hold('b')]);
		// No interleaving: each holder leaves before the next enters.
		assert.deepEqual(order, ['a:in', 'a:out', 'b:in', 'b:out']);
	});

	it('grants in FIFO order', async () => {
		// The bug this guards: a mutex that reopens on release lets whoever races
		// there first barge in, so a fast-typing document can starve a slow one.
		// A barging implementation passes the serialization test above unchanged.
		const m = new Mutex();
		const granted: number[] = [];
		const release = await m.acquire();
		const waiters = [1, 2, 3, 4].map(async (i) => {
			const r = await m.acquire();
			granted.push(i);
			r();
		});
		release();
		await Promise.all(waiters);
		assert.deepEqual(granted, [1, 2, 3, 4]);
	});

	it('ignores a double release', async () => {
		const m = new Mutex();
		const release = await m.acquire();
		release();
		release();
		// Still exclusive: the stray release must not have handed out a second permit.
		const second = await m.acquire();
		let entered = false;
		const blocked = m.acquire().then(() => {
			entered = true;
		});
		await new Promise((r) => setTimeout(r, 5));
		assert.equal(entered, false);
		second();
		await blocked;
	});
});
