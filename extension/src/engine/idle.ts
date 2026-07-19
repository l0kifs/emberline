/**
 * Idle self-shutdown.
 *
 * The extension starts this server and never stops it: the process is shared
 * across editor windows and kept warm for its KV cache, so no single window may
 * own its lifetime (see the extension's server/manage.ts). The cost of that policy
 * is that a crashed or force-quit editor would otherwise leave a ~1.6GB model
 * resident forever. Bounding the lifetime from inside closes that leak.
 *
 * A monotonic deadline, bumped on real completion traffic and checked on a coarse
 * timer. Not tied to /health -- a liveness probe means someone is watching, not
 * that anyone is typing, and letting probes keep the process alive would defeat
 * the timeout for exactly the abandoned-editor case it exists for.
 */

/**
 * `performance.now()`, not `Date.now()`: the deadline must not move when the
 * system clock is adjusted or the laptop resumes from sleep.
 */
type Clock = () => number;

export interface IdleDeps {
	/**
	 * Injected so tests can observe the fire without killing the runner. Default
	 * is SIGTERM to self, not `process.exit`: we want the same graceful path a
	 * Ctrl-C takes, so the shutdown handler still stops llama-server and closes
	 * the example store.
	 */
	onExpire?: () => void;
	now?: Clock;
	log?: (message: string) => void;
}

export class IdleShutdown {
	private readonly onExpire: () => void;
	private readonly now: Clock;
	private readonly log: (message: string) => void;
	private deadline = 0;
	private timer: NodeJS.Timeout | undefined;

	constructor(
		private readonly timeoutS: number,
		deps: IdleDeps = {},
	) {
		this.onExpire = deps.onExpire ?? (() => process.kill(process.pid, 'SIGTERM'));
		this.now = deps.now ?? (() => performance.now());
		this.log = deps.log ?? (() => {});
	}

	/** Record activity, pushing the deadline out. Cheap enough per request. */
	touch(): void {
		if (this.timeoutS <= 0) {
			return;
		}
		this.deadline = this.now() + this.timeoutS * 1000;
	}

	start(): void {
		if (this.timeoutS <= 0) {
			this.log('idle shutdown disabled');
			return;
		}
		this.touch();
		// Check at a fraction of the timeout so shutdown lands within ~1/20th of
		// the window. Clamped both ways: never looser than 30s (so the default
		// 1800s timeout still frees memory promptly once idle) and never tighter
		// than 50ms (so a misconfigured sub-second timeout cannot busy-loop).
		const intervalMs = Math.min(30_000, Math.max(50, (this.timeoutS * 1000) / 20));
		this.timer = setInterval(() => this.check(), intervalMs);
		// Unref'd: this timer must never be the reason the process stays alive.
		// The HTTP server is what holds the loop open.
		this.timer.unref();
	}

	stop(): void {
		if (this.timer !== undefined) {
			clearInterval(this.timer);
			this.timer = undefined;
		}
	}

	private check(): void {
		if (this.now() < this.deadline) {
			return;
		}
		this.log(`idle for ${this.timeoutS}s, shutting down`);
		this.stop();
		this.onExpire();
	}
}
