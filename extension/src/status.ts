import * as vscode from 'vscode';

type State = 'idle' | 'loading' | 'error' | 'disabled';

/**
 * One status bar item. Never thrashed per keystroke -- `set` is a no-op when the
 * state has not actually changed.
 */
export class StatusBar implements vscode.Disposable {
	private readonly item: vscode.StatusBarItem;
	private state: State | undefined;
	private detail = '';

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
		switch (state) {
			case 'idle':
				this.item.text = '$(sparkle) Emberline';
				this.item.tooltip = detail || 'Emberline: ready';
				this.item.backgroundColor = undefined;
				break;
			case 'loading':
				this.item.text = '$(loading~spin) Emberline';
				this.item.tooltip = 'Emberline: thinking…';
				this.item.backgroundColor = undefined;
				break;
			case 'error':
				this.item.text = '$(warning) Emberline';
				this.item.tooltip = `Emberline: ${detail || 'error'}`;
				this.item.backgroundColor = new vscode.ThemeColor(
					'statusBarItem.warningBackground',
				);
				break;
			case 'disabled':
				this.item.text = '$(circle-slash) Emberline';
				this.item.tooltip = 'Emberline: disabled';
				this.item.backgroundColor = undefined;
				break;
		}
	}

	dispose(): void {
		this.item.dispose();
	}
}
