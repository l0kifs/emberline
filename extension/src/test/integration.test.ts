import * as assert from 'assert';
import * as vscode from 'vscode';

import { Onboarding } from '../onboarding';

/** In-memory stand-in for `context.globalState`. */
class FakeMemento implements vscode.Memento {
	private readonly map = new Map<string, unknown>();
	keys(): readonly string[] {
		return [...this.map.keys()];
	}
	get<T>(key: string, defaultValue?: T): T {
		return (this.map.has(key) ? this.map.get(key) : defaultValue) as T;
	}
	async update(key: string, value: unknown): Promise<void> {
		this.map.set(key, value);
	}
}

/**
 * End-to-end through the real UI: trigger ghost text, commit it, then read the
 * document back.
 *
 * There is no `vscode.executeInlineCompletionProvider` command (verified against
 * the live command registry), so driving trigger/commit and asserting on the
 * resulting buffer is the honest way to test this -- and it exercises the whole
 * path including VS Code's own dispatch and debounce.
 *
 * Skips itself when no server is reachable, so the suite stays runnable offline.
 */

const ENDPOINT = 'http://127.0.0.1:8011';

/** `<publisher>.<name>` from package.json. */
const EXTENSION_ID = 'l0kifs.emberline';

/**
 * Asserts the extension exists before activating it. `getExtension(id)?.activate()`
 * silently does nothing when the id is wrong, and the suite still passes because
 * `onStartupFinished` activated it anyway -- so a publisher rename would quietly
 * stop this from testing what it claims to.
 */
async function activateEmberline(): Promise<void> {
	const ext = vscode.extensions.getExtension(EXTENSION_ID);
	assert.ok(ext, `extension ${EXTENSION_ID} not found -- did publisher or name change?`);
	await ext.activate();
}

async function serverUp(): Promise<boolean> {
	try {
		const res = await fetch(`${ENDPOINT}/health`, { signal: AbortSignal.timeout(2000) });
		return res.ok;
	} catch {
		return false;
	}
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Trigger inline suggest and commit whatever appears.
 * Returns the text inserted at the cursor, or '' if nothing showed up.
 */
async function triggerAndCommit(
	editor: vscode.TextEditor,
	waitMs = 8000,
): Promise<string> {
	const before = editor.document.getText();
	await vscode.commands.executeCommand('editor.action.inlineSuggest.trigger');

	// Poll for the commit to change the buffer. A cold completion is ~1s on this
	// hardware, so a fixed sleep would be either flaky or needlessly slow.
	const deadline = Date.now() + waitMs;
	while (Date.now() < deadline) {
		await sleep(250);
		await vscode.commands.executeCommand('editor.action.inlineSuggest.commit');
		await sleep(150);
		const after = editor.document.getText();
		if (after !== before) {
			return diff(before, after);
		}
	}
	return '';
}

/** The inserted span between two versions of the buffer. */
function diff(before: string, after: string): string {
	let start = 0;
	while (start < before.length && before[start] === after[start]) {
		start++;
	}
	let endB = before.length;
	let endA = after.length;
	while (endB > start && endA > start && before[endB - 1] === after[endA - 1]) {
		endB--;
		endA--;
	}
	return after.slice(start, endA);
}

/**
 * A Marketplace install has no server until the user starts one, so this is the
 * literal first-run state, and it must explain itself rather than fail silently.
 *
 * The prompt is driven directly rather than through the running extension: the
 * extension bundle receives its own `vscode` API object, so stubbing
 * `window.showWarningMessage` here cannot intercept what dist/extension.js calls.
 * The real-UI half below covers the wiring by asserting a dead endpoint stays
 * quiet and produces nothing.
 */
suite('first-run onboarding', function () {
	const DEAD = 'http://127.0.0.1:1';
	let seen: string[];
	let reply: string | undefined;
	let original: typeof vscode.window.showWarningMessage;
	let log: vscode.LogOutputChannel;

	suiteSetup(() => {
		log = vscode.window.createOutputChannel('Emberline Test', { log: true });
	});

	suiteTeardown(() => log.dispose());

	setup(() => {
		seen = [];
		reply = undefined;
		original = vscode.window.showWarningMessage;
		// A real notification would linger for the rest of the run; record instead.
		(vscode.window as any).showWarningMessage = (message: string) => {
			seen.push(message);
			return Promise.resolve(reply);
		};
	});

	teardown(() => {
		(vscode.window as any).showWarningMessage = original;
	});

	const flush = () => new Promise((r) => setTimeout(r, 0));

	test('names the endpoint and why nothing was started', async () => {
		new Onboarding(new FakeMemento(), log).serverUnreachable(DEAD);
		await flush();
		assert.strictEqual(seen.length, 1, `expected one prompt, saw ${seen.length}`);
		assert.ok(seen[0].includes(DEAD), `prompt should name the endpoint: ${seen[0]}`);
		// The server ships in the VSIX now, so the only reason to be here is that
		// the user turned managed mode off; the prompt has to say so.
		assert.ok(
			/manageServer/.test(seen[0]),
			`prompt should explain why nothing was started: ${seen[0]}`,
		);
	});

	// The provider calls this on every keystroke, so without a latch a dead server
	// stacks one notification per character typed.
	test('prompts only once per session', async () => {
		const onboarding = new Onboarding(new FakeMemento(), log);
		onboarding.serverUnreachable(DEAD);
		onboarding.serverUnreachable(DEAD);
		onboarding.serverUnreachable(DEAD);
		await flush();
		assert.strictEqual(seen.length, 1, `expected one prompt, saw ${seen.length}`);
	});

	test("'Don't Show Again' survives into a new session", async () => {
		const state = new FakeMemento();
		reply = "Don't Show Again";
		new Onboarding(state, log).serverUnreachable(DEAD);
		await flush();
		assert.strictEqual(seen.length, 1);

		// A fresh instance is what a window reload produces.
		new Onboarding(state, log).serverUnreachable(DEAD);
		await flush();
		assert.strictEqual(seen.length, 1, 'dismissal should persist in globalState');
	});

	test('a dead endpoint produces no ghost text and does not throw', async () => {
		const cfg = vscode.workspace.getConfiguration('emberline');
		await cfg.update('endpoint', DEAD, vscode.ConfigurationTarget.Global);
		try {
			await activateEmberline();
			const doc = await vscode.workspace.openTextDocument({
				language: 'python',
				content: 'import math\n\ndef area(r):\n    \n',
			});
			const editor = await vscode.window.showTextDocument(doc);
			editor.selection = new vscode.Selection(
				new vscode.Position(3, 4),
				new vscode.Position(3, 4),
			);
			assert.strictEqual(await triggerAndCommit(editor, 2000), '');
		} finally {
			await cfg.update('endpoint', undefined, vscode.ConfigurationTarget.Global);
		}
	});
});

/**
 * The command runs inside the extension's own module graph, but the setting it
 * writes is observable from here -- so unlike the notification, this is testable
 * through the real command.
 */
suite('toggle', function () {
	const emberline = () => vscode.workspace.getConfiguration('emberline');

	suiteSetup(async () => {
		await activateEmberline();
	});

	teardown(async () => {
		await emberline().update('enabled', undefined, vscode.ConfigurationTarget.Global);
	});

	// It used to flip a module-local `let enabled`: the state died on reload and
	// could disagree with `emberline.enabled`, leaving two gates and a status bar
	// that lied about one of them.
	test('writes emberline.enabled so it survives a reload', async () => {
		const doc = await vscode.workspace.openTextDocument({
			language: 'python',
			content: 'x = 1\n',
		});
		await vscode.window.showTextDocument(doc);

		assert.strictEqual(emberline().get('enabled'), true, 'default should be on');

		await vscode.commands.executeCommand('emberline.toggle');
		assert.strictEqual(emberline().get('enabled'), false, 'toggle should persist off');
		assert.strictEqual(
			emberline().inspect<boolean>('enabled')?.globalValue,
			false,
			'off should be written to user settings, not just an in-memory flag',
		);

		await vscode.commands.executeCommand('emberline.toggle');
		assert.strictEqual(emberline().get('enabled'), true, 'toggle should persist on again');
	});

	test('a language in disabledLanguages gets no completions', async () => {
		// Sets the blocklist explicitly rather than leaning on whatever the shipped
		// default happens to be. The earlier version asserted markdown produced
		// nothing, which quietly tested the default value instead of the mechanism --
		// so changing that default broke a test that was not about defaults at all.
		const cfg = vscode.workspace.getConfiguration('emberline');
		await cfg.update('disabledLanguages', ['markdown'], vscode.ConfigurationTarget.Global);
		try {
			// The provider reads Config, which refreshes on the change event.
			await sleep(250);
			const doc = await vscode.workspace.openTextDocument({
				language: 'markdown',
				content: '# notes\n\n',
			});
			const editor = await vscode.window.showTextDocument(doc);
			editor.selection = new vscode.Selection(
				new vscode.Position(2, 0),
				new vscode.Position(2, 0),
			);
			assert.strictEqual(await triggerAndCommit(editor, 1500), '');
		} finally {
			await cfg.update('disabledLanguages', undefined, vscode.ConfigurationTarget.Global);
			await sleep(250);
		}
	});
});

suite('emberline end-to-end', function () {
	suiteSetup(async function () {
		if (!(await serverUp())) {
			console.warn(`no server at ${ENDPOINT}; skipping end-to-end tests`);
			this.skip();
		}
		await activateEmberline();
		// Ghost text will not render if the user (or the test profile) has it off.
		await vscode.workspace
			.getConfiguration('editor')
			.update('inlineSuggest.enabled', true, vscode.ConfigurationTarget.Global);
	});

	test('renders and commits ghost text for a python FIM hole', async () => {
		const doc = await vscode.workspace.openTextDocument({
			language: 'python',
			content:
				'import math\n\n' +
				'def distance(x1, y1, x2, y2):\n' +
				'    """Euclidean distance between two points."""\n' +
				'    \n\n' +
				'print(distance(0, 0, 3, 4))\n',
		});
		const editor = await vscode.window.showTextDocument(doc);
		editor.selection = new vscode.Selection(
			new vscode.Position(4, 4),
			new vscode.Position(4, 4),
		);

		const inserted = await triggerAndCommit(editor);
		console.log(`  inserted: ${JSON.stringify(inserted)}`);

		assert.ok(inserted.length > 0, 'no ghost text was produced or committed');
		assert.ok(
			/sqrt|\*\*|return/.test(inserted),
			`expected distance-like code, got: ${inserted}`,
		);
	});

	test('completes in an unsaved buffer', async () => {
		// The bug this guards: a new untitled file is `plaintext` until you pick a
		// language, so a `disabledLanguages` default containing `plaintext` made
		// "completions do not work in unsaved files" look like a separate bug about
		// untitled buffers. It was the language blocklist both times.
		const doc = await vscode.workspace.openTextDocument({
			language: 'plaintext',
			content: 'def parse_timestamp(value):\n    ',
		});
		const editor = await vscode.window.showTextDocument(doc);
		assert.strictEqual(doc.uri.scheme, 'untitled', 'this must be an unsaved buffer');
		editor.selection = new vscode.Selection(
			new vscode.Position(1, 4),
			new vscode.Position(1, 4),
		);

		const inserted = await triggerAndCommit(editor);
		console.log(`  inserted (untitled/plaintext): ${JSON.stringify(inserted.slice(0, 80))}`);
		assert.ok(inserted.length > 0, 'no ghost text in an unsaved plaintext buffer');
	});

	test('completes inside a markdown fenced code block', async () => {
		// Markdown is enabled by default because of exactly this: prose suggestions
		// are weak, but fenced code is the same job the model is good at.
		const doc = await vscode.workspace.openTextDocument({
			language: 'markdown',
			content: '# Notes\n\n```python\nimport math\n\ndef hypotenuse(a, b):\n    ',
		});
		const editor = await vscode.window.showTextDocument(doc);
		editor.selection = new vscode.Selection(
			new vscode.Position(6, 4),
			new vscode.Position(6, 4),
		);

		const inserted = await triggerAndCommit(editor);
		console.log(`  inserted (markdown code block): ${JSON.stringify(inserted.slice(0, 80))}`);
		assert.ok(inserted.length > 0, 'no ghost text inside a fenced code block');
	});

	test('offers nothing when emberline.enabled is false', async () => {
		const cfg = vscode.workspace.getConfiguration('emberline');
		await cfg.update('enabled', false, vscode.ConfigurationTarget.Global);
		try {
			const doc = await vscode.workspace.openTextDocument({
				language: 'python',
				content: 'import math\n\ndef area(r):\n    \n',
			});
			const editor = await vscode.window.showTextDocument(doc);
			editor.selection = new vscode.Selection(
				new vscode.Position(3, 4),
				new vscode.Position(3, 4),
			);
			const inserted = await triggerAndCommit(editor, 3000);
			assert.strictEqual(inserted, '', 'should offer nothing when disabled');
		} finally {
			await cfg.update('enabled', undefined, vscode.ConfigurationTarget.Global);
		}
	});
});
