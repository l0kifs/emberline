/**
 * New in the TS port: llama_server.py was in the untested I/O half.
 *
 * These cover the lifecycle rules the rest of the design leans on, without
 * needing a real llama.cpp build.
 */

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, describe, it } from 'node:test';

import { LlamaServer, LlamaServerError } from '../../engine/llama';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'emberline-llama-'));
const CLOSERS: Array<() => void> = [];

after(() => {
	CLOSERS.forEach((c) => c());
	fs.rmSync(tmp, { recursive: true, force: true });
});

/** A stand-in for an already-running llama-server. */
async function fakeHealthy(): Promise<number> {
	const server = http.createServer((_req, res) => {
		res.writeHead(200, { 'content-type': 'application/json' });
		res.end('{"status":"ok"}');
	});
	await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
	CLOSERS.push(() => server.close());
	const addr = server.address();
	if (addr === null || typeof addr === 'string') {
		throw new Error('no port');
	}
	return addr.port;
}

function opts(over: Partial<ConstructorParameters<typeof LlamaServer>[0]> = {}) {
	return {
		binary: 'llama-server',
		host: '127.0.0.1',
		port: 8012,
		preset: '--fim-qwen-1.5b-default',
		extraArgs: ['-np', '1'],
		startupTimeoutS: 5,
		cacheDir: path.join(tmp, 'cache'),
		...over,
	};
}

describe('llama server', () => {
	it('reuses an already-healthy server instead of spawning', async () => {
		// This is what makes the F5 dev task idempotent and lets a second editor
		// window share the first one's engine rather than racing it.
		const port = await fakeHealthy();
		const logged: string[] = [];
		const llama = new LlamaServer(
			// A binary that cannot exist: reaching spawn at all would throw.
			opts({ port, binary: '/definitely/not/a/binary', log: (m) => logged.push(m) }),
		);
		await llama.start();
		assert.ok(
			logged.some((m) => m.includes('already healthy')),
			logged.join('\n'),
		);
	});

	it('never stops a server it did not spawn', async () => {
		// The invariant behind the extension's no-op dispose(): the engine is shared
		// and warm, so whoever finds it running must not own its lifetime.
		const port = await fakeHealthy();
		const llama = new LlamaServer(opts({ port, binary: '/definitely/not/a/binary' }));
		await llama.start();
		await llama.stop();
		// Still answering: stop() had no process of its own to kill.
		const res = await fetch(`http://127.0.0.1:${port}/health`);
		assert.equal(res.status, 200);
	});

	it('explains a missing binary instead of timing out', async () => {
		// A bare ENOENT after a 300s startup timeout is the difference between a
		// user installing llama.cpp and a user filing a bug about a hang.
		const llama = new LlamaServer(
			opts({ port: 8099, binary: 'emberline-nonexistent-binary', startupTimeoutS: 30 }),
		);
		await assert.rejects(llama.start(), (err: Error) => {
			assert.ok(err instanceof LlamaServerError);
			assert.match(err.message, /not found on PATH/);
			assert.match(err.message, /EMBERLINE__LLAMA_BINARY/);
			return true;
		});
	});

	it('reports a child that dies during startup, with its exit code', async () => {
		const llama = new LlamaServer(
			opts({ port: 8098, binary: 'false', preset: '', extraArgs: [], startupTimeoutS: 10 }),
		);
		await assert.rejects(llama.start(), /exited with code 1 during startup/);
	});

	it('gives up after the startup timeout, and stops the child', async () => {
		// A process that runs but never serves must not hold startup open forever.
		// The fake tolerates the --host/--port we append, which a bare `sleep` does
		// not -- it would exit 1 and take the "died during startup" path instead.
		const fake = path.join(tmp, 'never-ready.sh');
		fs.writeFileSync(fake, '#!/bin/sh\nsleep 30\n', { mode: 0o755 });

		const llama = new LlamaServer(
			opts({ port: 8097, binary: fake, preset: '', extraArgs: [], startupTimeoutS: 1 }),
		);
		await assert.rejects(llama.start(), /did not become healthy within 1s/);
		// start() calls stop() on the way out; nothing should be left running.
		await llama.stop();
	});

	it('puts the preset before the overrides so ours win', async () => {
		// --fim-qwen-* presets set their own host/port; ours have to come after, and
		// -np 1 has to survive both. Dropping it round-robins requests across
		// independent KV caches, which measured ~1.24s per keystroke instead of ~67ms.
		const seen: string[] = [];
		const llama = new LlamaServer(
			opts({ port: 8096, binary: 'true', log: (m) => seen.push(m), startupTimeoutS: 1 }),
		);
		await assert.rejects(llama.start());
		const cmd = seen.find((m) => m.startsWith('spawning:')) ?? '';
		assert.match(cmd, /--fim-qwen-1\.5b-default .*--host .*--port .*-np 1/);
	});
});
