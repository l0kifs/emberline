/**
 * Getting a server to exist.
 *
 * This is the one place the extension is allowed to be more than dumb. The
 * "deliberately dumb" thesis is about the *completion path* -- prompt assembly,
 * caching, ranking, trimming all stay server-side. Process lifecycle is not
 * latency-sensitive and has nowhere else to live: something outside the server
 * has to start the server.
 *
 * Resolution order, and why:
 *
 *   1. `emberline.manageServer: false` -> never spawn. The escape hatch for
 *      anyone running their own server on their own terms.
 *   2. Endpoint already healthy -> reuse. This single check is what keeps the F5
 *      dev loop untouched (the `server: start` task got there first) and what
 *      makes a second VS Code window share the first window's server instead of
 *      racing it. It mirrors `LlamaServer.start()`, which already reuses a
 *      healthy llama-server rather than spawning a second one.
 *   3. Otherwise install the server from PyPI via uv and spawn it.
 *
 * We deliberately do NOT kill the server on deactivate. It is a shared, warm
 * process: killing it would throw away the KV cache that the whole design exists
 * to keep warm, and would yank the server out from under any other window that
 * reused it. Bounded lifetime is the server's own job, via its idle shutdown.
 */

import { type ChildProcess, execFile, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { promisify } from 'node:util';
import * as vscode from 'vscode';

import type { Config } from '../config';
import { resolveUv, uvToolEnv } from './uv';

const exec = promisify(execFile);

/**
 * The server release this extension build expects. Pinned rather than floating:
 * an extension and a server that disagree about the wire contract is exactly the
 * failure this avoids. CI keeps it in step with server/pyproject.toml.
 */
const SERVER_VERSION = '0.1.0';
const SERVER_PACKAGE = 'emberline-server';

/** First run downloads ~1.6GB of model, and /health cannot answer until it lands. */
const STARTUP_TIMEOUT_MS = 10 * 60 * 1000;
const POLL_INTERVAL_MS = 500;
const CONSENT_KEY = 'emberline.serverSetupConsent';

export class ServerSetupError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'ServerSetupError';
	}
}

export class ServerManager implements vscode.Disposable {
	private proc: ChildProcess | undefined;
	private inflight: Promise<boolean> | undefined;
	private declined = false;

	constructor(
		private readonly ctx: vscode.ExtensionContext,
		private readonly cfg: Config,
		private readonly log: vscode.LogOutputChannel,
	) {}

	/**
	 * Ensure a server is reachable. Resolves true if one is (or now is).
	 *
	 * Single-flight: the provider calls this from a failed keystroke, and
	 * keystrokes arrive faster than a server starts. Without the latch, a burst
	 * would each try to install and spawn.
	 */
	async ensure(): Promise<boolean> {
		this.inflight ??= this.run().finally(() => {
			this.inflight = undefined;
		});
		return this.inflight;
	}

	private async run(): Promise<boolean> {
		if (await this.healthy()) {
			return true;
		}
		if (!this.cfg.manageServer) {
			this.log.info('server unreachable and emberline.manageServer is false; not spawning');
			return false;
		}
		if (this.declined) {
			return false;
		}
		if (!(await this.consent())) {
			this.declined = true;
			return false;
		}
		return this.provision();
	}

	/** Cheap liveness probe. Deliberately not the client's job -- see http.ts. */
	private async healthy(): Promise<boolean> {
		try {
			const res = await fetch(`${this.base()}/health`, {
				signal: AbortSignal.timeout(1500),
			});
			return res.ok;
		} catch {
			return false;
		}
	}

	private base(): string {
		return this.cfg.endpoint.replace(/\/+$/, '');
	}

	private port(): string {
		try {
			return new URL(this.cfg.endpoint).port || '8011';
		} catch {
			return '8011';
		}
	}

	/**
	 * Ask once, ever. Installing a Python toolchain and downloading gigabytes is
	 * not something to do behind someone's back, and the Marketplace publisher
	 * agreement (8(d)) draws the line at what a user "may reasonably expect".
	 */
	private async consent(): Promise<boolean> {
		if (this.ctx.globalState.get<boolean>(CONSENT_KEY)) {
			return true;
		}
		const setUp = 'Set up Emberline';
		const notNow = 'Not now';
		const choice = await vscode.window.showInformationMessage(
			'Emberline runs a code model on your machine. Set it up now? ' +
				'This downloads a local inference server and a ~1.6GB model. ' +
				'Nothing is sent off your machine.',
			{ modal: false },
			setUp,
			notNow,
		);
		if (choice !== setUp) {
			return false;
		}
		await this.ctx.globalState.update(CONSENT_KEY, true);
		return true;
	}

	private async provision(): Promise<boolean> {
		return vscode.window.withProgress(
			{ location: vscode.ProgressLocation.Notification, title: 'Emberline' },
			async (progress) => {
				try {
					const storage = this.ctx.globalStorageUri.fsPath;
					const env = uvToolEnv(storage);

					progress.report({ message: 'preparing…' });
					const uv = await resolveUv(storage, this.log, () =>
						progress.report({ message: 'downloading uv (~23MB)…' }),
					);

					progress.report({ message: 'installing the inference server…' });
					const spec = `${SERVER_PACKAGE}==${SERVER_VERSION}`;
					this.log.info(`installing ${spec} with ${uv}`);
					await exec(uv, ['tool', 'install', '--quiet', spec], {
						env: { ...process.env, ...env },
						timeout: 10 * 60 * 1000,
					});

					const bin = path.join(env.UV_TOOL_BIN_DIR, SERVER_PACKAGE);
					this.spawnServer(bin, env);

					progress.report({
						message: 'starting (first run downloads a ~1.6GB model)…',
					});
					await this.awaitHealthy();
					this.log.info('server is healthy');
					return true;
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					this.log.error(`server setup failed: ${message}`);
					void vscode.window
						.showErrorMessage(`Emberline setup failed: ${message}`, 'Show Logs')
						.then((c) => c && this.log.show());
					return false;
				}
			},
		);
	}

	private spawnServer(bin: string, env: Record<string, string>): void {
		const llama = this.bundledLlama();
		const serverEnv: NodeJS.ProcessEnv = {
			...process.env,
			...env,
			EMBERLINE__PORT: this.port(),
		};
		if (llama) {
			// The server spawns llama-server itself; it just needs to be told which
			// one. Absent (fallback VSIX), it falls back to PATH and reports a clear
			// error if nothing is there.
			// vsce preserves the 0o755 bit and VS Code's unzip honors it, but a
			// defensive chmod costs nothing and removes an EACCES failure class if a
			// future extraction path ever drops it (clangd's installer does the same).
			try {
				fs.chmodSync(llama, 0o755);
			} catch (err) {
				this.log.info(`could not chmod bundled llama-server: ${(err as Error).message}`);
			}
			serverEnv.EMBERLINE__LLAMA_BINARY = llama;
			this.log.info(`using bundled llama-server: ${llama}`);
		} else {
			this.log.info('no bundled llama-server in this VSIX; the server will look on PATH');
		}

		this.log.info(`spawning ${bin}`);
		this.proc = spawn(bin, [], {
			env: serverEnv,
			// Own process group and fully detached: this process must outlive the
			// window that happened to start it, because other windows share it.
			detached: true,
			stdio: 'ignore',
		});
		this.proc.unref();
		this.proc.on('exit', (code) => this.log.info(`server process exited with code ${code}`));
	}

	/** Path to the llama-server staged into this VSIX, if this build has one. */
	private bundledLlama(): string | undefined {
		if (process.platform !== 'darwin' || process.arch !== 'arm64') {
			return undefined;
		}
		const p = path.join(this.ctx.extensionUri.fsPath, 'bin', 'llama', 'llama-server');
		return fs.existsSync(p) ? p : undefined;
	}

	private async awaitHealthy(): Promise<void> {
		const deadline = Date.now() + STARTUP_TIMEOUT_MS;
		while (Date.now() < deadline) {
			// A server that died during startup will never answer; fail now with its
			// exit code rather than sitting on the full timeout.
			if (this.proc && this.proc.exitCode !== null) {
				throw new ServerSetupError(
					`the server exited with code ${this.proc.exitCode} during startup`,
				);
			}
			if (await this.healthy()) {
				return;
			}
			await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
		}
		throw new ServerSetupError(
			`the server did not become reachable at ${this.base()} within ` +
				`${Math.round(STARTUP_TIMEOUT_MS / 60000)} minutes`,
		);
	}

	dispose(): void {
		// Intentionally does not kill `this.proc`. See the module docstring: the
		// server is shared across windows and stays warm on purpose. It bounds its
		// own lifetime with an idle shutdown.
	}
}
