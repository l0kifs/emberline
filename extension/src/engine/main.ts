/**
 * Composition root for the Emberline sidecar.
 *
 * Entry point of `dist/server.js`, spawned by the extension on VS Code's own
 * Node (`ELECTRON_RUN_AS_NODE=1`). No `vscode` import is possible here: there is
 * no extension host in this process. See docs/typescript-migration.md.
 *
 * Everything is wired into one `EngineContext` and handed to the routes. There is
 * no dependency-injection container, deliberately -- the graph is a dozen objects
 * built once at startup.
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { Assembler } from './assemble';
import { CompletionCache } from './cache';
import {
	examplesPath,
	hfHome,
	llamaUrl,
	loadSettings,
	logPath,
	paramsDigestInput,
	type Settings,
} from './config';
import { ExampleStore } from './examples';
import { createServer, type EngineContext } from './http';
import { IdleShutdown } from './idle';
import { InfillClient } from './infill';
import { LlamaServer } from './llama';
import { RingContext } from './ring';
import { Supersede } from './supersede';

/**
 * Logs go to a file as well as stderr.
 *
 * The extension spawns this detached with stdio ignored, so stderr reaches
 * nobody in the normal case. Without the file, a server that dies during startup
 * would be undiagnosable. Surfaced by the `Emberline: Show Server Log` command.
 */
function makeLogger(settings: Settings): (message: string) => void {
	let sink: fs.WriteStream | undefined;
	try {
		fs.mkdirSync(settings.dataDir, { recursive: true });
		sink = fs.createWriteStream(logPath(settings), { flags: 'a' });
		// An unwritable log must never take down the server.
		sink.on('error', () => {
			sink = undefined;
		});
	} catch {
		sink = undefined;
	}
	return (message: string) => {
		const line = `${new Date().toISOString()} ${message}\n`;
		process.stderr.write(line);
		sink?.write(line);
	};
}

async function main(): Promise<void> {
	const settings = loadSettings();
	const log = makeLogger(settings);
	// The `server: start` task's problem matcher uses this as its beginsPattern,
	// and "Application startup complete" below as its endsPattern. Change either
	// string and F5 hangs. See .vscode/tasks.json.
	log('emberline server starting');

	let llama: LlamaServer | null = null;
	if (settings.llamaManaged) {
		llama = new LlamaServer({
			binary: settings.llamaBinary,
			host: settings.llamaHost,
			port: settings.llamaPort,
			preset: settings.llamaPreset,
			// -np 1 is not optional. The FIM presets leave slots on auto, which
			// round-robins requests across independent KV caches: measured, that
			// made every other keystroke a full 793-token recompute (~1.24s)
			// instead of a ~67ms cache hit.
			extraArgs: ['-np', '1', ...settings.llamaExtraArgs],
			startupTimeoutS: settings.llamaStartupTimeoutS,
			cacheDir: hfHome(settings),
			log,
		});
		// Throwing here is deliberate: a server that cannot reach a model should
		// refuse to serve rather than 500 on every keystroke. The extension reads
		// our exit code and reports it.
		await llama.start();
	} else {
		log(`llamaManaged=false; expecting a server at ${llamaUrl(settings)}`);
	}

	const idle = new IdleShutdown(settings.idleTimeoutS, { log });
	const infill = new InfillClient(llamaUrl(settings));

	let examples: ExampleStore | null = null;
	if (settings.examplesEnabled) {
		examples = new ExampleStore({
			filePath: examplesPath(settings),
			topK: settings.examplesTopK,
			minSimilarity: settings.examplesMinSimilarity,
			maxRows: settings.examplesMaxRows,
			log,
		});
		await examples.start();
	}

	const ctx: EngineContext = {
		settings,
		infill,
		cache: new CompletionCache(settings.cacheMaxEntries),
		supersede: new Supersede(),
		assembler: new Assembler(settings, {
			ring: new RingContext({
				maxChunks: settings.ringMaxChunks,
				chunkLines: settings.ringChunkLines,
			}),
			examples,
			log: (message, err) => log(`${message}: ${String(err)}`),
		}),
		examples,
		paramsDigest: createHash('sha256')
			.update(paramsDigestInput(settings))
			.digest('hex')
			.slice(0, 16),
		idle,
		log,
	};

	const server = createServer(ctx);

	let shuttingDown = false;
	const shutdown = async (signal: string) => {
		if (shuttingDown) {
			return;
		}
		shuttingDown = true;
		log(`received ${signal}, shutting down`);
		idle.stop();
		server.close();
		// Required, not defensive: the extension holds a keep-alive socket by
		// design, and server.close() waits for idle connections. Without this the
		// process hangs instead of shutting down, still holding ~1.6GB of model.
		server.closeAllConnections();
		infill.close();
		// Flush any queued append before the process goes away, or the last
		// accepted completion is lost.
		await examples?.close();
		await llama?.stop();
		process.exit(0);
	};
	process.on('SIGTERM', () => void shutdown('SIGTERM'));
	process.on('SIGINT', () => void shutdown('SIGINT'));

	// SIGTERM, not process.exit, so idle shutdown takes the same path a Ctrl-C
	// does and llama-server still gets stopped.
	idle.start();

	await new Promise<void>((resolve) => server.listen(settings.port, settings.host, resolve));
	log(`emberline ready on ${settings.host}:${settings.port}`);
	// The `server: start` task's problem matcher watches for this exact string;
	// changing it hangs F5. See CLAUDE.md.
	log('Application startup complete');
}

main().catch((err: unknown) => {
	const message = err instanceof Error ? err.message : String(err);
	process.stderr.write(`emberline failed to start: ${message}\n`);
	try {
		const settings = loadSettings();
		fs.appendFileSync(
			path.join(settings.dataDir, 'server.log'),
			`${new Date().toISOString()} startup failed: ${message}\n`,
		);
	} catch {
		/* the log is best-effort; the exit code is what the extension reads */
	}
	process.exit(1);
});
