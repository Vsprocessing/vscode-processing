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

		const footer = await vscode.window.showInputBox({
			title: vscode.l10n.t('Export Website'),
			prompt: vscode.l10n.t('Footer text'),
			value: '',
			ignoreFocusOut: true
		});
		if (footer === undefined) {
			return;
		}

		const startedAt = Date.now();
		this.log('\n==== BEGIN WEBSITE EXPORT ====\n');
		this.log('[export] Output target: wasm-gc + js');

		const compiled = await this.compileSketch(workspaceFolder);
		await this.writeArtifacts(workspaceFolder.uri, compiled);
		await this.writeRuntime(workspaceFolder.uri, compiled);
		await this.writeIndex(workspaceFolder.uri, name.trim(), footer);

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
	private async writeIndex(root: vscode.Uri, name: string, footer: string): Promise<void> {
		const uri = vscode.Uri.joinPath(root, indexName);
		if (await exists(uri)) {
			const replace = vscode.l10n.t('Replace');
			const keep = vscode.l10n.t('Keep Existing');
			const choice = await vscode.window.showWarningMessage(
				vscode.l10n.t('{0} already exists. Replace it with a newly generated page?', indexName),
				{ modal: true, detail: vscode.l10n.t('Any changes you made to {0} will be lost. The compiled sketch and {1} are updated either way.', indexName, runtimeName) },
				replace,
				keep
			);
			if (choice !== replace) {
				this.log(`[export] Kept existing ${indexName}.`);
				return;
			}
		}

		await this.writeText(uri, this.renderIndex(name, footer));
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
		status: null,
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
		setStatus(text) {
			if (this.status) {
				this.status.textContent = text;
			}
		},
		showError(error) {
			const text = toText(error);
			if (this.error) {
				this.error.hidden = false;
				this.error.textContent = text;
			}
			this.appendLine(text);
			this.setStatus('Run failed.');
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

	async function runWasm(parent) {
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
		const backend = processingModule.createCanvas2DBackend(parent, {});
		program.execute({ canvasBackend: backend });
		UI.setStatus('Running WebAssembly build.');
	}

	async function runJs(parent) {
		await loadP5();
		const module = await import('./${compiled.js.name}');
		if (typeof module.start !== 'function') {
			throw new Error('${compiled.js.name} did not export start.');
		}
		if (typeof window.p5 !== 'function') {
			throw new Error('p5.js is not available.');
		}
		new window.p5(p => {
			p.setup = () => {
				const result = module.start(p);
				if (result && typeof result.then === 'function') {
					void result.then(() => UI.setStatus('Program finished.'));
				}
			};
		}, parent);
		UI.setStatus('Running JavaScript build.');
	}

	async function run() {
		UI.status = document.getElementById('status');
		UI.console = document.getElementById('console');
		UI.error = document.getElementById('error');
		UI.clearError();
		installConsoleCapture();

		const mount = document.getElementById('sketch');
		if (!mount) {
			throw new Error('Missing sketch mount element.');
		}

		UI.setStatus('Loading WebAssembly build...');
		try {
			await runWasm(mount);
		} catch (error) {
			console.warn('WebAssembly build failed, trying JavaScript build.', error);
			UI.setStatus('Loading JavaScript build...');
			await runJs(mount);
		}
	}

	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', () => run().catch(error => UI.showError(error)));
	} else {
		void run().catch(error => UI.showError(error));
	}
})();`;
	}

	private renderIndex(name: string, footer: string): string {
		const title = escapeHtml(name);
		const footerContent = escapeHtml(footer);
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
			--muted-foreground: rgba(31, 31, 31, .72);
			--border-color: rgba(31, 31, 31, .16);
			--console-background: rgba(0, 0, 0, .06);
			--error-background: #fff0f0;
			--error-border: #d12f2f;
			font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
			background: var(--page-background);
			color: var(--page-foreground);
		}
		@media (prefers-color-scheme: dark) {
			:root {
				--page-background: #151515;
				--page-foreground: #f5f5f5;
				--muted-foreground: rgba(255, 255, 255, .72);
				--border-color: rgba(255, 255, 255, .14);
				--console-background: rgba(0, 0, 0, .35);
				--error-background: #4d1111;
				--error-border: #a33;
			}
		}
		body {
			margin: 0;
			min-height: 100vh;
			display: grid;
			grid-template-rows: auto 1fr auto;
		}
		header, footer {
			padding: 16px 20px;
		}
		header {
			border-bottom: 1px solid var(--border-color);
		}
		h1 {
			margin: 0;
			font-size: 20px;
			font-weight: 600;
		}
		main {
			display: grid;
			grid-template-rows: 1fr auto;
			min-height: 0;
		}
		#sketch {
			display: grid;
			place-items: center;
			min-height: 320px;
			overflow: hidden;
		}
		canvas {
			max-width: 100%;
			max-height: 100%;
			object-fit: contain;
		}
		#status {
			padding: 8px 20px;
			color: var(--muted-foreground);
			font-size: 13px;
		}
		#error {
			margin: 0 20px 12px;
			padding: 12px;
			white-space: pre-wrap;
			background: var(--error-background);
			border: 1px solid var(--error-border);
			border-radius: 4px;
		}
		#console {
			margin: 0;
			padding: 12px 20px;
			max-height: 180px;
			overflow: auto;
			white-space: pre-wrap;
			background: var(--console-background);
			font: 12px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
		}
		footer {
			color: var(--muted-foreground);
			border-top: 1px solid var(--border-color);
		}
	</style>
	<meta name="webprocessing-export" content="${debug}">
</head>
<body>
	<header>
		<h1>${title}</h1>
	</header>
	<main>
		<div id="sketch"></div>
		<div id="status">Loading...</div>
		<pre id="error" hidden></pre>
		<pre id="console"></pre>
	</main>
	<footer>${footerContent}</footer>
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
