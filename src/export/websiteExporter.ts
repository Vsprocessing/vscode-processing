import * as vscode from 'vscode';
import type { CompilerOutput, ProcessingCompiler } from '../compiler/processingCompiler';
import type { BuildOutputKind } from '../core/types';
import {
	buildArtifactFileName, collectSources, countLines, exists, getWorkspaceFolder, identifyEntrypoint, type WorkspaceSource
} from '../utils';

declare const TextDecoder: {
	new(): { decode(input?: Uint8Array): string };
};

declare const TextEncoder: {
	new(): { encode(input?: string): Uint8Array };
};

const runtimeName = 'runtime.js';
const indexName = 'index.html';
const anonymousAuthor = 'Anonymous';
const websiteUrl = 'https://vsp.cloudtron.us';
const bootLogoSvg = '<svg viewBox="10 -10 710 690" aria-hidden="true" fill="none">'
	+ '<path d="M400 500C700 500 700 100 400 100" stroke="#fff" stroke-width="150" fill="none"/>'
	+ '<path d="M400 200L100 600" stroke="#fff" stroke-width="150" fill="none"/>'
	+ '<path d="M100 300L200 500" stroke="#fff" stroke-width="150" fill="none"/></svg>';

interface PageDetails {
	readonly name: string;
	readonly author: string;
	/** May contain line breaks, entered as `\n`. */
	readonly description: string;
}

interface WebsiteCompileOutput {
	readonly wasm: CompilerOutput;
	readonly js: CompilerOutput;
}

export class WebsiteExporter {
	constructor(
		private readonly extensionUri: vscode.Uri,
		private readonly compiler: ProcessingCompiler,
		private readonly softwareVersion: string,
		private readonly log: (message?: string) => void
	) { }

	async export(): Promise<void> {
		const workspaceFolder = getWorkspaceFolder();
		if (!workspaceFolder) {
			void vscode.window.showWarningMessage(vscode.l10n.t('Open a workspace folder before exporting a website.'));
			return;
		}

		const name = await vscode.window.showInputBox({
			title: vscode.l10n.t('Export Website'),
			prompt: vscode.l10n.t('Website name'),
			value: workspaceFolder.name,
			ignoreFocusOut: true,
			validateInput: value => value.trim() ? undefined : vscode.l10n.t('Enter a website name.')
		});
		if (name === undefined) {
			return;
		}

		const author = await vscode.window.showInputBox({
			title: vscode.l10n.t('Export Website'),
			prompt: vscode.l10n.t('Author name'),
			placeHolder: anonymousAuthor,
			ignoreFocusOut: true
		});
		if (author === undefined) {
			return;
		}

		const description = await vscode.window.showInputBox({
			title: vscode.l10n.t('Export Website'),
			prompt: vscode.l10n.t('Description'),
			placeHolder: vscode.l10n.t('Use \\n for a line break'),
			value: '',
			ignoreFocusOut: true
		});
		if (description === undefined) {
			return;
		}

		const startedAt = Date.now();
		this.log('\n==== BEGIN WEBSITE EXPORT ====\n');
		this.log('[export] Output target: wasm-gc + js');

		const compiled = await this.compileSketch(workspaceFolder);
		await this.writeArtifacts(workspaceFolder.uri, compiled);
		await this.writeRuntime(workspaceFolder.uri, compiled);
		await this.writeIndex(workspaceFolder.uri, { name: name.trim(), author: author.trim() || anonymousAuthor, description: description.trim() });

		this.log(`[export] Website export succeeded in ${Date.now() - startedAt}ms.`);
		void vscode.window.showInformationMessage(vscode.l10n.t('Website export succeeded.'));
	}

	private async compileSketch(workspaceFolder: vscode.WorkspaceFolder): Promise<WebsiteCompileOutput> {
		this.log('[export] Collecting Processing sources...');
		const { sources } = await collectSources('processing');
		if (!sources.length) {
			throw new Error('No .pde files were found.');
		}
		for (const source of sources) {
			this.log(`[export] Found ${source.path} (${countLines(source.content)} lines, ${source.content.length} chars)`);
		}

		const entrypoint = identifyEntrypoint(sources, workspaceFolder);
		if (!entrypoint && sources.length > 1) {
			throw new Error('Cannot determine program entrypoint for a multi-file project. Use foldername.pde or main.pde.');
		}

		const mainSource = entrypoint ?? sources[0];
		this.log(`[export] Entrypoint: ${mainSource.path}`);

		const [wasm, js] = await Promise.all([
			this.compileProcessingOutput(sources, mainSource, buildArtifactFileName(workspaceFolder, 'wasm'), 'wasm-gc'),
			this.compileProcessingOutput(sources, mainSource, buildArtifactFileName(workspaceFolder, 'wasm'), 'js')
		]);

		return { wasm, js };
	}

	private async compileProcessingOutput(
		sources: readonly WorkspaceSource[],
		mainSource: WorkspaceSource,
		targetFileName: string,
		output: BuildOutputKind
	): Promise<CompilerOutput> {
		const compiled = await this.compiler.compile('processing', sources, mainSource, targetFileName, output);
		if (compiled.output !== output) {
			throw new Error(`Expected ${output} output, got ${compiled.output}.`);
		}
		return compiled;
	}

	private async writeArtifacts(root: vscode.Uri, compiled: WebsiteCompileOutput): Promise<void> {
		if (!compiled.wasm.bytes) {
			throw new Error('WebAssembly build did not produce bytes.');
		}
		if (!compiled.js.text) {
			throw new Error('JavaScript build did not produce text.');
		}

		await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(root, compiled.wasm.name), compiled.wasm.bytes);
		await this.writeText(vscode.Uri.joinPath(root, compiled.js.name), compiled.js.text);
		this.log(`[export] Wrote ${compiled.wasm.name}.`);
		this.log(`[export] Wrote ${compiled.js.name}.`);
	}

	/** The runtime is generated output and always matches the build it was exported with. */
	private async writeRuntime(root: vscode.Uri, compiled: WebsiteCompileOutput): Promise<void> {
		const uri = vscode.Uri.joinPath(root, runtimeName);
		const existed = await exists(uri);
		await this.writeText(uri, await this.renderRuntime(compiled));
		this.log(`[export] ${existed ? 'Updated' : 'Created'} ${runtimeName}.`);
	}

	/** Writes the page; an existing index.html may have been edited, so ask before replacing it. */
	private async writeIndex(root: vscode.Uri, page: PageDetails): Promise<void> {
		const uri = vscode.Uri.joinPath(root, indexName);
		if (await exists(uri)) {
			const replace = vscode.l10n.t('Replace');
			const keep = vscode.l10n.t('Keep Existing');
			const choice = await vscode.window.showWarningMessage(
				vscode.l10n.t('{0} already exists. Replace it with a newly generated page?', indexName),
				{ modal: true, detail: vscode.l10n.t('Any changes you made to {0} will be lost.', indexName) },
				replace,
				keep
			);
			if (choice !== replace) {
				this.log(`[export] Kept existing ${indexName}.`);
				return;
			}
		}

		await this.writeText(uri, this.renderIndex(page));
		this.log(`[export] Wrote ${indexName}.`);
	}

	private async renderRuntime(compiled: WebsiteCompileOutput): Promise<string> {
		const [teavmJavac, processingTeavm, wasmRuntime, p5] = await Promise.all([
			this.readAssetText('teavm-javac.js'),
			this.readAssetText('processing-teavm.js'),
			this.readAssetText('compiler.wasm-runtime.js'),
			this.readMediaText('p5.min.js')
		]);

		return `(() => {
	const sources = {
		teavmJavac: ${JSON.stringify(teavmJavac)},
		processingTeavm: ${JSON.stringify(processingTeavm)},
		wasmRuntime: ${JSON.stringify(wasmRuntime)},
		p5: ${JSON.stringify(p5)}
	};
	const urls = new Map();

	function objectUrl(name, text) {
		if (!urls.has(name)) {
			urls.set(name, URL.createObjectURL(new Blob([text], { type: 'text/javascript' })));
		}
		return urls.get(name);
	}

	function rewriteBundledModuleSource(text) {
		return text.replace(/new URL\\((["'])(\\.\\/[^"']+)\\1,\\s*import\\.meta\\.url\\)/g, '$1$2$1');
	}

	function toText(value) {
		if (value instanceof Error) {
			return value.stack || value.name + ': ' + value.message;
		}
		if (typeof value === 'string') {
			return value;
		}
		try {
			return JSON.stringify(value);
		} catch {
			return String(value);
		}
	}

	const UI = {
		console: null,
		error: null,
		append(text) {
			if (!this.console) {
				return;
			}
			this.console.textContent += text;
			this.console.scrollTop = this.console.scrollHeight;
		},
		appendLine(text) {
			this.append(text + '\\n');
		},
		showError(error) {
			const text = toText(error);
			if (this.error) {
				this.error.hidden = false;
				this.error.textContent = text;
			}
			this.appendLine(text);
		},
		clearError() {
			if (this.error) {
				this.error.hidden = true;
				this.error.textContent = '';
			}
		}
	};

	function installConsoleCapture() {
		for (const level of ['log', 'info', 'debug', 'warn', 'error']) {
			const original = console[level].bind(console);
			console[level] = (...values) => {
				UI.appendLine(values.map(toText).join(' '));
				original(...values);
			};
		}
		window.addEventListener('error', event => UI.showError(event.error || event.message));
		window.addEventListener('unhandledrejection', event => UI.showError(event.reason));
	}

	/** Scales the sketch canvas so the whole page fits the window. */
	function installCanvasFit(stage, mount) {
		const fit = () => {
			const canvas = mount.querySelector('canvas');
			if (!canvas) {
				return;
			}
			const width = canvas.width || canvas.clientWidth;
			const height = canvas.height || canvas.clientHeight;
			if (!width || !height) {
				return;
			}
			const style = getComputedStyle(stage);
			const available = {
				width: stage.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
				height: stage.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom)
			};
			const scale = Math.max(0, Math.min(available.width / width, available.height / height));
			canvas.style.width = Math.floor(width * scale) + 'px';
			canvas.style.height = Math.floor(height * scale) + 'px';
		};

		new ResizeObserver(fit).observe(stage);
		new MutationObserver(fit).observe(mount, { childList: true, subtree: true, attributes: true, attributeFilter: ['width', 'height'] });
		window.addEventListener('resize', fit);
		fit();
		return fit;
	}

	function installControls(fit) {
		const consoleView = document.getElementById('console');
		const toggle = document.getElementById('toggleConsole');
		if (toggle && consoleView) {
			toggle.addEventListener('click', () => {
				const show = consoleView.hidden;
				consoleView.hidden = !show;
				toggle.setAttribute('aria-pressed', String(show));
				fit();
			});
		}

		const info = document.getElementById('info');
		const showInfo = document.getElementById('showInfo');
		if (info && showInfo) {
			// close() is delayed so the closing animation can play
			const dismiss = () => {
				info.classList.add('closing');
				const done = () => {
					info.classList.remove('closing');
					info.close();
				};
				const animations = info.getAnimations();
				if (animations.length) {
					Promise.all(animations.map(animation => animation.finished.catch(() => undefined))).then(done);
				} else {
					done();
				}
			};
			showInfo.addEventListener('click', () => info.showModal());
			info.addEventListener('click', event => {
				if (event.target === info) {
					dismiss();
				}
			});
			info.addEventListener('cancel', event => {
				event.preventDefault();
				dismiss();
			});
		}
	}

	function runtimeModules() {
		const teavmJavacUrl = objectUrl('teavm-javac.js', rewriteBundledModuleSource(sources.teavmJavac));
		const processingSource = rewriteBundledModuleSource(sources.processingTeavm)
			.replace(/from\\s+["']\\.\\/teavm-javac\\.js["']/g, 'from ' + JSON.stringify(teavmJavacUrl));
		return Promise.all([
			import(objectUrl('compiler.wasm-runtime.js', sources.wasmRuntime)),
			import(objectUrl('processing-teavm.js', processingSource))
		]);
	}

	async function loadP5() {
		if (typeof window.p5 === 'function') {
			return;
		}
		await new Promise((resolve, reject) => {
			const script = document.createElement('script');
			script.src = objectUrl('p5.min.js', sources.p5);
			script.onload = resolve;
			script.onerror = () => reject(new Error('Failed to load p5.js runtime.'));
			document.head.appendChild(script);
		});
	}

	/** Loads the WebAssembly build; the returned function starts the sketch. */
	async function prepareWasm(parent) {
		const [runtimeModule, processingModule] = await runtimeModules();
		const response = await fetch('./${compiled.wasm.name}');
		if (!response.ok) {
			throw new Error('Failed to load ${compiled.wasm.name}: HTTP ' + response.status);
		}
		const program = await processingModule.createProcessingProgram(new Uint8Array(await response.arrayBuffer()), {
			runtimeModule,
			stdio: {
				stdin: '',
				stdout: text => UI.append(String(text)),
				stderr: text => UI.append(String(text))
			}
		});
		return () => {
			const backend = processingModule.createCanvas2DBackend(parent, {});
			program.execute({ canvasBackend: backend });
		};
	}

	async function prepareJs(parent) {
		await loadP5();
		const module = await import('./${compiled.js.name}');
		if (typeof module.start !== 'function') {
			throw new Error('${compiled.js.name} did not export start.');
		}
		if (typeof window.p5 !== 'function') {
			throw new Error('p5.js is not available.');
		}
		return () => {
			new window.p5(p => {
				p.setup = () => module.start(p);
			}, parent);
		};
	}

	/** Resolves when the boot animation has finished and the overlay is gone. */
	function bootAnimation() {
		const boot = document.getElementById('boot');
		if (!boot) {
			return Promise.resolve();
		}
		const wordmark = boot.querySelector('.wordmark');
		const intro = wordmark
			? Promise.all(wordmark.getAnimations().map(animation => animation.finished.catch(() => undefined)))
			: Promise.resolve();
		return intro.then(() => {
			boot.classList.add('done');
			return Promise.all(boot.getAnimations().map(animation => animation.finished.catch(() => undefined)));
		}).then(() => boot.remove());
	}

	async function run() {
		UI.console = document.getElementById('console');
		UI.error = document.getElementById('error');
		UI.clearError();
		installConsoleCapture();

		const stage = document.getElementById('stage');
		const mount = document.getElementById('sketch');
		if (!stage || !mount) {
			throw new Error('Missing sketch mount element.');
		}
		const fit = installCanvasFit(stage, mount);
		installControls(fit);

		// The sketch is prepared while the boot animation plays, so it starts the moment it ends.
		const prepared = prepareWasm(mount).catch(error => {
			console.warn('WebAssembly build failed, trying JavaScript build.', error);
			return prepareJs(mount);
		});
		const [start] = await Promise.all([prepared, bootAnimation()]);
		start();
		fit();
	}

	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', () => run().catch(error => UI.showError(error)));
	} else {
		void run().catch(error => UI.showError(error));
	}
})();`;
	}

	private renderIndex(page: PageDetails): string {
		const title = escapeHtml(page.name);
		const author = escapeHtml(page.author);
		const description = escapeHtml(page.description.replace(/\\n/g, '\n'));
		const debug = escapeHtml(`Built by Web Processing ${this.softwareVersion}.`);
		return `<!doctype html>
<html lang="en">
<head>
	<meta charset="utf-8">
	<meta name="viewport" content="width=device-width, initial-scale=1">
	<title>${title}</title>
	<style>
		:root {
			color-scheme: light dark;
			--page-background: #f3f3f3;
			--page-foreground: #1f1f1f;
			--muted-foreground: rgba(31, 31, 31, .6);
			--border-color: rgba(31, 31, 31, .14);
			--console-background: rgba(0, 0, 0, .05);
			--hover-background: rgba(31, 31, 31, .08);
			--error-background: #fff0f0;
			--error-border: #d12f2f;
			font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
		}
		@media (prefers-color-scheme: dark) {
			:root {
				--page-background: #151515;
				--page-foreground: #f5f5f5;
				--muted-foreground: rgba(255, 255, 255, .6);
				--border-color: rgba(255, 255, 255, .12);
				--console-background: rgba(0, 0, 0, .35);
				--hover-background: rgba(255, 255, 255, .1);
				--error-background: #4d1111;
				--error-border: #a33;
			}
		}
		* { box-sizing: border-box; }
		body {
			margin: 0;
			height: 100vh;
			height: 100dvh;
			overflow: hidden;
			display: grid;
			grid-template-rows: auto minmax(0, 1fr);
			background: var(--page-background);
			color: var(--page-foreground);
		}
		header {
			display: flex;
			align-items: center;
			gap: 12px;
			padding: 10px 16px;
			border-bottom: 1px solid var(--border-color);
		}
		h1 {
			margin: 0;
			font-size: 17px;
			font-weight: 600;
			white-space: nowrap;
			overflow: hidden;
			text-overflow: ellipsis;
		}
		.by {
			color: var(--muted-foreground);
			font-size: 13px;
			white-space: nowrap;
		}
		.spacer { flex: 1; }
		.icon-button {
			display: inline-flex;
			align-items: center;
			justify-content: center;
			width: 30px;
			height: 30px;
			padding: 0;
			border: 0;
			border-radius: 6px;
			background: transparent;
			color: inherit;
			cursor: pointer;
		}
		.icon-button:hover { background: var(--hover-background); }
		.icon-button[aria-pressed="true"] { background: var(--hover-background); }
		.icon-button svg { width: 17px; height: 17px; fill: currentColor; }
		main {
			display: grid;
			grid-template-rows: minmax(0, 1fr) auto auto;
			min-height: 0;
		}
		#stage {
			position: relative;
			display: grid;
			place-items: center;
			min-height: 0;
			overflow: hidden;
			padding: 10px;
		}
		#sketch { line-height: 0; }
		canvas { display: block; }
		#console {
			margin: 0;
			padding: 8px 16px;
			/* three lines, then scroll */
			max-height: calc(3 * 1.45em + 20px);
			overflow: auto;
			white-space: pre-wrap;
			background: var(--console-background);
			border-top: 1px solid var(--border-color);
			font: 12px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
		}
		#error {
			margin: 0;
			padding: 10px 16px;
			white-space: pre-wrap;
			background: var(--error-background);
			border-top: 1px solid var(--error-border);
			font: 12px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
		}
		dialog#info {
			width: min(560px, 92vw);
			min-height: min(320px, 70vh);
			max-height: 86vh;
			padding: 28px 30px;
			border: 1px solid var(--border-color);
			border-radius: 14px;
			background: var(--page-background);
			color: var(--page-foreground);
			box-shadow: 0 24px 60px rgba(0, 0, 0, .35);
		}
		dialog#info[open] {
			display: flex;
			flex-direction: column;
			animation: dialog-in .2s cubic-bezier(.2, .7, .3, 1) both;
		}
		dialog#info[open]::backdrop { animation: backdrop-in .2s ease-out both; }
		dialog#info.closing { animation: dialog-out .14s ease-in both; }
		dialog#info.closing::backdrop { animation: backdrop-in .14s ease-in reverse both; }
		dialog#info::backdrop { background: rgba(0, 0, 0, .45); }
		dialog#info h2 { margin: 0; font-size: 22px; }
		@keyframes dialog-in {
			from { opacity: 0; transform: translateY(12px) scale(.96); }
			to { opacity: 1; transform: translateY(0) scale(1); }
		}
		@keyframes dialog-out {
			to { opacity: 0; transform: translateY(8px) scale(.98); }
		}
		@keyframes backdrop-in {
			from { opacity: 0; }
			to { opacity: 1; }
		}
		dialog#info .by { display: block; margin-top: 2px; }
		dialog#info p { margin: 18px 0 0; line-height: 1.6; white-space: pre-wrap; }
		dialog#info .description { flex: 1; }
		dialog#info .made {
			margin-top: 20px;
			padding-top: 12px;
			border-top: 1px solid var(--border-color);
			color: var(--muted-foreground);
			font-size: 13px;
		}
		dialog#info a { color: inherit; }
		#boot {
			position: absolute;
			inset: 0;
			z-index: 2;
			display: flex;
			align-items: center;
			justify-content: center;
			background: #000;
			color: #fff;
		}
		#boot.done { animation: boot-out .16s ease-in forwards; }
		#boot svg { width: 46px; height: 46px; flex: none; animation: boot-logo .2s ease-out both; }
		#boot .wordmark {
			/* Expands to the right, which pushes the logo left into its final position. */
			overflow: hidden;
			white-space: nowrap;
			font-size: 23px;
			font-weight: 600;
			animation: boot-wordmark .3s cubic-bezier(.2, .7, .3, 1) .2s both;
		}
		@keyframes boot-logo {
			from { opacity: 0; transform: scale(.9); }
			to { opacity: 1; transform: scale(1); }
		}
		@keyframes boot-wordmark {
			from { max-width: 0; opacity: 0; padding-left: 0; }
			to { max-width: 320px; opacity: 1; padding-left: 14px; }
		}
		@keyframes boot-out {
			to { opacity: 0; visibility: hidden; }
		}
		@media (prefers-reduced-motion: reduce) {
			#boot svg, #boot .wordmark { animation-duration: .01s; animation-delay: 0s; }
		}
	</style>
	<meta name="webprocessing-export" content="${debug}">
</head>
<body>
	<header>
		<h1>${title}</h1>
		<span class="by">by ${author}</span>
		<span class="spacer"></span>
		<button id="toggleConsole" class="icon-button" type="button" aria-pressed="false" title="Console" aria-label="Console">
			<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1.5 2h13A1.5 1.5 0 0 1 16 3.5v9a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 0 12.5v-9A1.5 1.5 0 0 1 1.5 2Zm0 1.5v9h13v-9h-13Zm2 1.94 1.06-1.06 2.47 2.47-2.47 2.47L3.5 8.25 4.81 6.94 3.5 5.44ZM8 9.5h4.5V11H8V9.5Z"/></svg>
		</button>
		<button id="showInfo" class="icon-button" type="button" title="About" aria-label="About">
			<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1Zm0 1.5A5.5 5.5 0 1 1 8 13.5 5.5 5.5 0 0 1 8 2.5Zm-.75 2h1.5V6h-1.5V4.5Zm0 2.75h1.5v4.25h-1.5V7.25Z"/></svg>
		</button>
	</header>
	<main>
		<div id="stage">
			<div id="sketch"></div>
			<div id="boot">
				${bootLogoSvg}
				<span class="wordmark">VS Processing</span>
			</div>
		</div>
		<pre id="console" hidden></pre>
		<pre id="error" hidden></pre>
	</main>
	<dialog id="info">
		<h2>${title}</h2>
		<span class="by">by ${author}</span>
		<p class="description">${description || 'No description provided.'}</p>
		<p class="made">Made with <a href="${websiteUrl}" target="_blank" rel="noreferrer noopener">VS Processing</a></p>
	</dialog>
	<script type="module" src="./${runtimeName}"></script>
</body>
</html>`;
	}

	private async readAssetText(name: string): Promise<string> {
		return new TextDecoder().decode(await vscode.workspace.fs.readFile(this.compiler.assetUri(name)));
	}

	private async readMediaText(name: string): Promise<string> {
		return new TextDecoder().decode(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(this.extensionUri, 'media', name)));
	}

	private async writeText(uri: vscode.Uri, text: string): Promise<void> {
		await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(text));
	}
}

function escapeHtml(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}
