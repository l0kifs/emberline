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
 *   3. Otherwise spawn the bundled sidecar.
 *
 * The sidecar ships inside the VSIX as `dist/server.js` and runs on VS Code's own
 * Node, via `ELECTRON_RUN_AS_NODE`. There is nothing to install: no Python, no
 * uv, no PyPI download. (`process.execPath` is Electron in the desktop host and a
 * real node binary in a Remote/WSL host; the variable is inert in the latter.)
 *
 * We deliberately do NOT kill the server on deactivate. It is a shared, warm
 * process: killing it would throw away the KV cache that the whole design exists
 * to keep warm, and would yank the server out from under any other window that
 * reused it. Bounded lifetime is the server's own job, via its idle shutdown.
 */

import { type ChildProcess, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';

import type { Config } from '../config';
import { loadSettings, logPath } from '../engine/config';
import type { StatusBar } from '../status';

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
	private spawnedAt: number | undefined;
	private inflight: Promise<boolean> | undefined;
	private declined = false;
	private provisioning = false;

	/**
	 * True while the bundled server is being started (the multi-minute first-run
	 * model download). The provider uses this so a keystroke that fails during the
	 * download does not stomp the 'starting' status back to 'error'.
	 */
	get isProvisioning(): boolean {
		return this.provisioning;
	}

	constructor(
		private readonly ctx: vscode.ExtensionContext,
		private readonly cfg: Config,
		private readonly log: vscode.LogOutputChannel,
		private readonly status: StatusBar,
	) {}

	/**
	 * Ensure a server is reachable. Resolves true if one is (or now is).
	 *
	 * Single-flight: the provider calls this from a failed keystroke, and
	 * keystrokes arrive faster than a server starts. Without the latch, a burst
	 * would each try to spawn.
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
	 * Ask once, ever.
	 *
	 * The server itself now ships in the VSIX, so this is no longer about
	 * installing a toolchain -- but it still downloads a ~1.6GB model and starts a
	 * long-lived background process, which is squarely what the Marketplace
	 * publisher agreement (8(d)) means by "beyond what may reasonably be expected".
	 */
	private async consent(): Promise<boolean> {
		if (this.ctx.globalState.get<boolean>(CONSENT_KEY)) {
			return true;
		}
		const setUp = 'Set up Emberline';
		const notNow = 'Not now';
		const choice = await vscode.window.showInformationMessage(
			'Emberline runs a code model on your machine. Set it up now? ' +
				'This downloads a ~1.6GB model and starts a local inference server. ' +
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
		this.provisioning = true;
		try {
			return await this.provisionInner();
		} finally {
			this.provisioning = false;
		}
	}

	private async provisionInner(): Promise<boolean> {
		return vscode.window.withProgress(
			{ location: vscode.ProgressLocation.Notification, title: 'Emberline' },
			async (progress) => {
				// Until now the status bar showed 'error' (the keystroke that triggered
				// this caught ServerUnreachableError) for the whole multi-minute first
				// run. Show the 'starting' indicator instead.
				this.status.set('starting', 'Emberline: starting the local server (first run downloads a model)…');
				try {
					this.spawnServer();
					progress.report({
						message: 'starting (first run downloads a ~1.6GB model)…',
					});
					await this.awaitHealthy();
					this.log.info('server is healthy');
					this.status.set('idle');
					return true;
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					this.log.error(`server setup failed: ${message}`);
					this.status.set('error', message);
					void vscode.window
						.showErrorMessage(`Emberline setup failed: ${message}`, 'Show Logs')
						.then((c) => c && this.log.show());
					return false;
				}
			},
		);
	}

	/** The sidecar bundled into this VSIX. */
	private serverEntry(): string {
		const p = path.join(this.ctx.extensionUri.fsPath, 'dist', 'server.js');
		if (!fs.existsSync(p)) {
			// Only reachable from a broken package. Worth naming, because the spawn
			// would otherwise fail silently: stdio is ignored, so node's "cannot find
			// module" goes nowhere and this would look like a hang.
			throw new ServerSetupError(
				`this build is missing its inference server (${p}). Reinstall the extension.`,
			);
		}
		return p;
	}

	private spawnServer(): void {
		const entry = this.serverEntry();
		const env: NodeJS.ProcessEnv = {
			...process.env,
			// Makes the Electron binary behave as plain Node. Inert when the
			// extension host is already Node (Remote/WSL/SSH).
			ELECTRON_RUN_AS_NODE: '1',
			EMBERLINE__PORT: this.port(),
		};

		const llama = this.bundledLlama();
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
			env.EMBERLINE__LLAMA_BINARY = llama;
			this.log.info(`using bundled llama-server: ${llama}`);
		} else {
			this.log.info('no bundled llama-server in this VSIX; the server will look on PATH');
		}

		this.log.info(`spawning ${process.execPath} ${entry}`);
		this.spawnedAt = Date.now();
		this.proc = spawn(process.execPath, [entry], {
			env,
			// Own process group and fully detached: this process must outlive the
			// window that happened to start it, because other windows share it.
			detached: true,
			// The server writes its own log; see `emberline.showServerLog`.
			stdio: 'ignore',
		});
		this.proc.unref();
		this.proc.on('exit', (code) => this.log.info(`server process exited with code ${code}`));
	}

	/**
	 * The reason the server logged before exiting, if it is from *this* spawn.
	 *
	 * The timestamp check is the whole point: a log left by an earlier failed run
	 * would otherwise be reported as the cause of a later, unrelated one — which is
	 * worse than the generic message, because it is confidently wrong.
	 */
	private startupFailure(): string | undefined {
		if (this.spawnedAt === undefined) {
			return undefined;
		}
		const marker = 'startup failed:';
		try {
			const lines = fs.readFileSync(logPath(loadSettings()), 'utf8').trimEnd().split('\n');
			for (let i = lines.length - 1; i >= 0; i--) {
				const line = lines[i];
				const at = line.indexOf(marker);
				if (at === -1) {
					continue;
				}
				const stamp = Date.parse(line.slice(0, line.indexOf(' ')));
				// 2s of slack: the log timestamp is written by the other process.
				if (Number.isNaN(stamp) || stamp < this.spawnedAt - 2000) {
					return undefined;
				}
				return line.slice(at + marker.length).trim();
			}
		} catch {
			// No log, unreadable, or a data dir we cannot resolve. Fall back.
		}
		return undefined;
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
				// Prefer the server's own account of what went wrong. "exited with
				// code 1" is true and useless; the actionable line ("llama-server not
				// found on PATH...") is sitting in its log, and the overwhelmingly
				// common first-run failure on any platform without a bundled engine is
				// exactly that one.
				const reason = this.startupFailure();
				throw new ServerSetupError(
					reason ??
						`the server exited with code ${this.proc.exitCode} during startup. ` +
							`See "Emberline: Show Server Log".`,
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
