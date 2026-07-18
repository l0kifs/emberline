/**
 * Lifecycle for the llama-server subprocess.
 *
 * We shell out to llama.cpp's server rather than embedding a binding so we
 * inherit `/infill`: it reads the FIM token spellings out of the GGUF metadata.
 * That matters -- there are at least four mutually incompatible spellings in the
 * wild (Qwen `<|fim_prefix|>`, StarCoder2 `<fim_prefix>`, DeepSeek's fullwidth
 * `<｜fim▁begin｜>`, Seed-Coder's bracket-dash) crossed with PSM vs SPM ordering.
 * Hand-rolling that is the classic silent-breakage bug. We also get --cache-reuse,
 * the 3:1 prefix:suffix batch clamp, and crash isolation for free.
 */

import { type ChildProcess, spawn } from 'node:child_process';
import * as fs from 'node:fs';

import { getStatus } from './httpc';

export class LlamaServerError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'LlamaServerError';
	}
}

export interface LlamaServerOptions {
	binary: string;
	host: string;
	port: number;
	preset: string;
	extraArgs: string[];
	startupTimeoutS: number;
	cacheDir: string;
	log?: (message: string) => void;
}

const HEALTH_TIMEOUT_MS = 1000;
const POLL_INTERVAL_MS = 250;

/**
 * Platform-appropriate install advice.
 *
 * Only `darwin-arm64` ships a bundled engine, so everyone else reaches this --
 * and telling a Linux user to run Homebrew is worse than saying nothing.
 */
function installHint(): string {
	if (process.platform === 'darwin') {
		return 'Install llama.cpp: `brew install llama.cpp`.';
	}
	if (process.platform === 'win32') {
		return 'Install llama.cpp from https://github.com/ggml-org/llama.cpp/releases and put llama-server.exe on PATH.';
	}
	return (
		'Install llama.cpp — a release binary from ' +
		'https://github.com/ggml-org/llama.cpp/releases, your package manager, or a source build — ' +
		'and put llama-server on PATH.'
	);
}

/** Spawns llama-server and waits for it to report healthy. */
export class LlamaServer {
	private proc: ChildProcess | undefined;
	private spawnError: LlamaServerError | undefined;
	private readonly log: (message: string) => void;

	constructor(private readonly opts: LlamaServerOptions) {
		this.log = opts.log ?? (() => {});
	}

	get url(): string {
		return `http://${this.opts.host}:${this.opts.port}`;
	}

	/**
	 * Environment for the subprocess, pinning the model cache to our data dir.
	 *
	 * Both variables are set deliberately: LLAMA_CACHE takes precedence over
	 * HF_HOME in llama.cpp (verified empirically), so setting only HF_HOME would
	 * be silently overridden for anyone who already exports LLAMA_CACHE. Note the
	 * different levels -- HF_HOME is the parent and llama.cpp appends "/hub",
	 * whereas LLAMA_CACHE names the hub directory itself.
	 */
	private env(): NodeJS.ProcessEnv {
		return {
			...process.env,
			HF_HOME: this.opts.cacheDir,
			LLAMA_CACHE: `${this.opts.cacheDir}/hub`,
		};
	}

	private command(): string[] {
		const cmd = [this.opts.binary];
		if (this.opts.preset) {
			cmd.push(this.opts.preset);
		}
		// After the preset, so these win on conflict.
		cmd.push('--host', this.opts.host, '--port', String(this.opts.port));
		cmd.push(...this.opts.extraArgs);
		return cmd;
	}

	async start(): Promise<void> {
		if (await this.isHealthy()) {
			// Leaves `proc` undefined, so stop() can never kill a server we did not
			// spawn. This is what makes the F5 dev task idempotent and lets a second
			// editor window share the first one's engine.
			this.log(`llama-server already healthy at ${this.url}, not spawning`);
			return;
		}

		const [bin, ...args] = this.command();
		fs.mkdirSync(this.opts.cacheDir, { recursive: true });
		this.log(`spawning: ${this.command().join(' ')}`);
		this.log(`model cache: ${this.opts.cacheDir}/hub`);

		this.proc = spawn(bin, args, {
			env: this.env(),
			// Own process group, so a SIGINT to us (Ctrl-C in the dev loop) does not
			// race the child's own handler; we terminate it explicitly instead.
			detached: true,
			// There are no model logs to read through Emberline, by design.
			stdio: 'ignore',
		});

		// Recorded rather than raced. Racing the spawn error against the health poll
		// leaves the poll running for the whole startup timeout -- 300s by default --
		// holding the event loop open long after start() rejected. The poll checks
		// this instead, so failure is observed once and nothing outlives it.
		this.proc.once('error', (err: NodeJS.ErrnoException) => {
			this.proc = undefined;
			this.spawnError =
				err.code === 'ENOENT'
					? new LlamaServerError(
							`'${this.opts.binary}' not found on PATH. ${installHint()} ` +
								`Or set EMBERLINE__LLAMA_BINARY to an existing llama-server.`,
						)
					: new LlamaServerError(`could not spawn llama-server: ${err.message}`);
		});

		await this.awaitHealthy();
		this.log(`llama-server healthy at ${this.url}`);
	}

	private async isHealthy(): Promise<boolean> {
		return (await getStatus(`${this.url}/health`, HEALTH_TIMEOUT_MS)) === 200;
	}

	/**
	 * Poll /health until 200.
	 *
	 * First run downloads the model, hence the generous timeout. /health returns
	 * 503 {"error": {"message": "Loading model"}} while warming.
	 */
	private async awaitHealthy(): Promise<void> {
		const deadline = performance.now() + this.opts.startupTimeoutS * 1000;
		while (performance.now() < deadline) {
			if (this.spawnError !== undefined) {
				throw this.spawnError;
			}
			if (this.proc !== undefined && this.proc.exitCode !== null) {
				throw new LlamaServerError(
					`llama-server exited with code ${this.proc.exitCode} during startup`,
				);
			}
			if (await this.isHealthy()) {
				return;
			}
			await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
		}
		await this.stop();
		throw new LlamaServerError(
			`llama-server did not become healthy within ${this.opts.startupTimeoutS}s`,
		);
	}

	async stop(): Promise<void> {
		const proc = this.proc;
		if (proc === undefined || proc.exitCode !== null || proc.pid === undefined) {
			return;
		}
		this.log(`stopping llama-server (pid ${proc.pid})`);
		const exited = new Promise<void>((resolve) => proc.once('exit', () => resolve()));

		this.signal(proc.pid, 'SIGTERM');
		// The timer is cleared either way: an uncleared 10s timer would keep the
		// event loop alive that much longer on every clean shutdown.
		let timer: NodeJS.Timeout | undefined;
		const graceful = await Promise.race([
			exited.then(() => true),
			new Promise<boolean>((r) => {
				timer = setTimeout(() => r(false), 10_000);
			}),
		]).finally(() => clearTimeout(timer));
		if (!graceful) {
			this.log('llama-server ignored SIGTERM, killing');
			this.signal(proc.pid, 'SIGKILL');
			await exited;
		}
		this.proc = undefined;
	}

	/**
	 * Signal the child's whole process group.
	 *
	 * The negative pid addresses the group, which works only because `detached`
	 * made the child its leader. Windows has no process groups; that path is
	 * untested, as it was in the Python server -- the bundled llama-server ships
	 * only for darwin-arm64 and the PATH fallback has never been exercised there.
	 */
	private signal(pid: number, sig: 'SIGTERM' | 'SIGKILL'): void {
		try {
			if (process.platform === 'win32') {
				spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
				return;
			}
			process.kill(-pid, sig);
		} catch {
			// Already gone, or not ours to signal.
			try {
				process.kill(pid, sig);
			} catch {
				/* nothing left to stop */
			}
		}
	}
}
