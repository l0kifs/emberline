/**
 * Newest-wins request arbitration.
 *
 * One model, one GPU: requests must serialize. But while a request waits its turn
 * the user has usually typed again, making it garbage on arrival -- GitHub reports
 * roughly half of issued completion requests are "typed through" this way. So we
 * serialize on a lock *and* drop anything that went stale while queued.
 *
 * Scoped per session (one editor document), not global: a single global counter
 * is correct for one desktop user but means a second client's keystroke would
 * abort the first client's generation.
 */

/**
 * FIFO async mutex.
 *
 * Ownership passes directly from the releaser to the head of the queue rather
 * than reopening the lock for whoever races to it first. That fairness is what
 * stops a fast-typing document from starving a slow one; a barging
 * implementation would look identical in tests and misbehave only under load.
 */
export class Mutex {
	private locked = false;
	private readonly waiters: Array<() => void> = [];

	async acquire(): Promise<() => void> {
		if (this.locked) {
			await new Promise<void>((resolve) => this.waiters.push(resolve));
		} else {
			this.locked = true;
		}
		let released = false;
		return () => {
			if (released) {
				return;
			}
			released = true;
			const next = this.waiters.shift();
			if (next) {
				// Hand the lock over still held, so no one can barge in between.
				next();
			} else {
				this.locked = false;
			}
		};
	}

	async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
		const release = await this.acquire();
		try {
			return await fn();
		} finally {
			release();
		}
	}
}

/**
 * Generation counters, scoped per session.
 *
 * Pair with `modelLock`, which is global on purpose: llama-server runs with a
 * single slot (`-np 1`), so there is exactly one KV cache. Letting two documents
 * generate concurrently would make them evict each other's cached prefix and
 * turn every request into a full recompute -- measured at ~1.24s versus ~67ms
 * for a cache hit.
 */
export class Supersede {
	private readonly generations = new Map<string, number>();
	readonly modelLock = new Mutex();

	/** Register a new request, invalidating older ones in the same session. */
	claim(sessionId: string): number {
		const gen = (this.generations.get(sessionId) ?? 0) + 1;
		this.generations.set(sessionId, gen);
		return gen;
	}

	isStale(sessionId: string, generation: number): boolean {
		return (this.generations.get(sessionId) ?? 0) !== generation;
	}

	forget(sessionId: string): void {
		this.generations.delete(sessionId);
	}
}
