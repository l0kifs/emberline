/**
 * Last-writer-wins debounce.
 *
 * The timer is not the latch -- the request id is. Several provider calls can be
 * in their wait window at once; only the newest proceeds. Modelled on Continue's
 * debouncer.
 *
 * VS Code already applies its own cancellation-aware ~50ms debounce before the
 * provider is invoked (pinned at min=max=50 in inlineCompletionsController), so
 * whatever we add here stacks on top of that.
 */

export class Debouncer {
	private currentId = 0;

	/** Resolves true if this call should be abandoned. */
	async shouldSkip(delayMs: number, signal: AbortSignal): Promise<boolean> {
		if (delayMs <= 0) {
			return signal.aborted;
		}
		const id = ++this.currentId;
		await sleep(delayMs, signal);
		if (signal.aborted) {
			return true;
		}
		// A newer keystroke started waiting while we slept.
		return this.currentId !== id;
	}
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		if (signal.aborted) {
			resolve();
			return;
		}
		const timer = setTimeout(() => {
			signal.removeEventListener('abort', onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			resolve();
		};
		signal.addEventListener('abort', onAbort, { once: true });
	});
}
