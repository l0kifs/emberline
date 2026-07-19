/**
 * Ported from server/tests/test_idle.py.
 *
 * The editor starts this server and never stops it (the process is shared across
 * windows and kept warm), so the only thing bounding its lifetime is this timer.
 * If touch() stops pushing the deadline out, or /health is wired to touch(), a
 * force-quit editor leaks a ~1.6GB model forever -- the exact leak this guards.
 */

import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { IdleShutdown } from '../../engine/idle';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('idle shutdown', () => {
	it('never fires when disabled', async () => {
		// timeout 0 means "do not bound lifetime"; start() must be a no-op, not a
		// zero-delay shutdown.
		let fired = 0;
		const idle = new IdleShutdown(0, { onExpire: () => fired++ });
		idle.start();
		await sleep(50);
		idle.stop();
		assert.equal(fired, 0);
	});

	it('fires after the timeout', async () => {
		let fired = 0;
		const idle = new IdleShutdown(0.1, { onExpire: () => fired++ });
		idle.start();
		await sleep(250);
		idle.stop();
		assert.equal(fired, 1);
	});

	it('pushes the deadline out on touch', async () => {
		// A server under steady completion traffic must never shut down. If touch()
		// failed to reset the deadline, this would fire mid-stream.
		let fired = 0;
		const idle = new IdleShutdown(0.2, { onExpire: () => fired++ });
		idle.start();
		for (let i = 0; i < 6; i++) {
			await sleep(50);
			idle.touch();
		}
		assert.equal(fired, 0);
		idle.stop();
	});

	it('does not fire after stop', async () => {
		let fired = 0;
		const idle = new IdleShutdown(0.1, { onExpire: () => fired++ });
		idle.start();
		idle.stop();
		await sleep(200);
		assert.equal(fired, 0);
	});

	it('fires only once', async () => {
		// The bug this guards: an interval that keeps running after expiry would
		// re-send SIGTERM every tick, racing the graceful shutdown it just started.
		let fired = 0;
		const idle = new IdleShutdown(0.05, { onExpire: () => fired++ });
		idle.start();
		await sleep(300);
		idle.stop();
		assert.equal(fired, 1);
	});

	it('reads the deadline from the same clock that set it', async () => {
		// The bug this guards: setting the deadline from one clock and checking it
		// against another. Mixing the injected clock into touch() with a bare
		// Date.now() in the expiry check makes every comparison true, so the server
		// shuts down on its first tick -- while someone is typing.
		let now = 0;
		let fired = 0;
		// 0.5s -> a 50ms check interval, so the check really does run several times
		// while the injected clock stays frozen short of the deadline.
		const idle = new IdleShutdown(0.5, { onExpire: () => fired++, now: () => now });
		idle.start();
		await sleep(200);
		assert.equal(fired, 0);
		idle.stop();
	});
});
