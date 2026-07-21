import * as vscode from 'vscode';

type State = 'idle' | 'loading' | 'starting' | 'error' | 'disabled';

// The status bar is a single-colour codicon glyph; state is carried by a custom
// icon font (contributes.icons, ids below) tinted an ember colour. VS Code's only
// built-in animation is `~spin`, which does not fit this mark, so the "thinking"
// sweep and "starting" blink are done here by swapping pre-rendered frame glyphs
// on a timer. The glyphs come from scripts/build-icon-font.mjs; see the approved
// design in docs/design/status-icon-design.html.
const THINK_FRAMES = ['ember-think-1', 'ember-think-2', 'ember-think-3', 'ember-think-4'];
const START_FRAMES = ['ember-start-on', 'ember-start-off'];
const THINK_FRAME_MS = 180;
const START_FRAME_MS = 530;

const EMBER = new vscode.ThemeColor('emberline.statusIcon');
const DIM = new vscode.ThemeColor('disabledForeground');
const ERROR_BG = new vscode.ThemeColor('statusBarItem.errorBackground');

/**
 * One status bar item. Never thrashed per keystroke -- `set` is a no-op when the
 * state has not actually changed, which also means a burst of `set('loading')`
 * calls does not restart the sweep animation.
 *
 * Icon-only, no text label -- status bar space is scarce. Identity rides on the
 * tooltip. `idle` shows the Ready mark; `loading`/`starting` animate via
 * frame-swap (`animate`); `error` reuses the Ready mark on the error pill (which
 * pairs its own legible foreground); `disabled` shows the slashed mark, dimmed.
 */
export class StatusBar implements vscode.Disposable {
	private readonly item: vscode.StatusBarItem;
	private state: State | undefined;
	private detail = '';
	private anim: ReturnType<typeof setInterval> | undefined;

	constructor() {
		this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
		this.item.command = 'emberline.toggle';
		this.set('idle');
		this.item.show();
	}

	set(state: State, detail = ''): void {
		if (this.state === state && this.detail === detail) {
			return;
		}
		this.state = state;
		this.detail = detail;
		// Any state change ends the previous animation; static states never restart it.
		this.stopAnim();
		switch (state) {
			case 'idle':
				this.item.text = '$(ember-ready)';
				this.item.tooltip = detail || 'Emberline: ready';
				this.item.color = EMBER;
				this.item.backgroundColor = undefined;
				break;
			case 'loading':
				this.item.tooltip = 'Emberline: thinking…';
				this.item.color = EMBER;
				this.item.backgroundColor = undefined;
				this.animate(THINK_FRAMES, THINK_FRAME_MS);
				break;
			case 'starting':
				this.item.tooltip = detail || 'Emberline: starting…';
				this.item.color = EMBER;
				this.item.backgroundColor = undefined;
				this.animate(START_FRAMES, START_FRAME_MS);
				break;
			case 'error':
				this.item.text = '$(ember-ready)';
				this.item.tooltip = `Emberline: ${detail || 'error'}`;
				// The error background auto-pairs a legible foreground, so leave color unset.
				this.item.color = undefined;
				this.item.backgroundColor = ERROR_BG;
				break;
			case 'disabled':
				this.item.text = '$(ember-disabled)';
				this.item.tooltip = 'Emberline: disabled';
				this.item.color = DIM;
				this.item.backgroundColor = undefined;
				break;
		}
	}

	/** Cycle `frames` on `ms`, showing the first immediately. */
	private animate(frames: string[], ms: number): void {
		let i = 0;
		const show = (): void => {
			this.item.text = `$(${frames[i % frames.length]})`;
			i++;
		};
		show();
		this.anim = setInterval(show, ms);
	}

	private stopAnim(): void {
		if (this.anim !== undefined) {
			clearInterval(this.anim);
			this.anim = undefined;
		}
	}

	dispose(): void {
		this.stopAnim();
		this.item.dispose();
	}
}
