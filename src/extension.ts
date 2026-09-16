import * as vscode from 'vscode';
import * as javaCompilerPackage from '@worldeditaxe/teavm-javac';
import * as processingCompilerPackage from '@worldeditaxe/teavm-javac/processing';
import type { CreateCompilerOptions } from '@worldeditaxe/teavm-javac';
import { assignmentPath, loadCsptUnpacker, readAssignmentData, writeAssignmentData } from './assignment/assignmentLoader';
import type { CompileCheck, CsptAssignment, CsptCheckResult, ValidatorCheck } from './assignment/types';
import { ProcessingLinter } from './java-lsp/processingLsp';
import { teavmPackageUri } from './compiler/teavmPackage';
import { AssignmentViewProvider } from './views/assignmentView';
import { ProcessingCompiler } from './compiler/processingCompiler';
import { WebsiteExporter } from './export/websiteExporter';
import {
	buildArtifactFileName, buildArtifactFileUri, collectSources, countLines,
	createNonce, escapeScriptJson, formatDiagnostic, formatDuration,
	getWorkspaceFolder, hasSources, identifyEntrypoint, isBuildArtifactOutdated,
	isInWorkspaceFolder, isTempBuildArtifactOutdated, readTemplate,
	renderTemplate, sourceVersions, statOrUndefined, stripExtension, stripWasmExtension,
	toJavaIdentifier, type SourceKind, type WorkspaceSource
} from './utils';

declare function setTimeout(handler: (...args: unknown[]) => void, timeout?: number): unknown;

const compileCommand = 'webprocessing.compile';
const runCommand = 'webprocessing.run';
const stopCommand = 'webprocessing.stop';
const openReferenceCommand = 'webprocessing.openReference';
const openApcsaReferenceCommand = 'webprocessing.openApcsaReference';
const exportWebsiteCommand = 'webprocessing.exportWebsite';
const refreshAssignmentsCommand = 'webprocessing.refreshAssignments';
const controlsViewType = 'webprocessing.controls';
const runtimeViewType = 'webruntime';
const referenceViewType = 'webprocessing.reference';
const assignmentBrowserViewType = 'webprocessing.assignments';
const defaultOpenStateKey = 'webprocessing.defaultOpen.v1';
const defaultAssignmentStoreUrls = ['https://vsp-cspt-store.cloudtron.us/'];
// Temporarily hidden features; set to true to re-enable their UI.
const assignmentsEnabled = false;
const exportWebsiteEnabled = true;

type ProcessingModule = typeof processingCompilerPackage;
type CompilerModule = typeof javaCompilerPackage;

interface BuildArtifact {
	readonly mode: SourceKind;
	readonly scope: string;
	readonly name: string;
	readonly uri?: vscode.Uri;
	readonly bytes?: Uint8Array;
	readonly sourceVersions?: ReadonlyMap<string, number>;
	readonly outdated: boolean;	// if the compiled file outdated?
}

interface ExtensionState {
	readonly mode: SourceKind;
	readonly hasSources: boolean;	// has source files?
	readonly hasCompiled: boolean;	// has compiled file?
	readonly isCompiling: boolean;
	readonly isRunning: boolean;
	readonly isOutdated: boolean;
}

interface ExtensionControlsViewState extends ExtensionState {
	readonly status: string;
	readonly warning: string;
	readonly assignmentsEnabled: boolean;
	readonly exportWebsiteEnabled: boolean;
}

interface AssignmentCatalogItem {
	readonly catalogKey: string;
	readonly storeUrl: string;
	readonly id: string;
	readonly name: string;
	readonly descriptionPreview: string;
}

type AssignmentCatalogEntry = Omit<AssignmentCatalogItem, 'catalogKey' | 'storeUrl'>;

interface AssignmentTarget {
	readonly uri: vscode.Uri;
	readonly name: string;
}

export function activate(context: vscode.ExtensionContext): void {
	const extension = new Extension(context);
	context.subscriptions.push(extension);
}

function normalizeRuntimeFilePath(path: string): string | undefined {
	const normalized = path.replace(/\\/g, '/').replace(/^\/+/, '');
	if (!normalized || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(normalized)) {
		return undefined;
	}
	const parts = normalized.split('/');
	if (parts.some(part => !part || part === '.' || part === '..')) {
		return undefined;
	}
	return parts.join('/');
}

function createRuntimeFileNotFoundError(path: string): Error {
	const error = new Error(`Runtime file not found: ${path}`);
	error.name = 'FileNotFoundError';
	return error;
}

function runtimeFileErrorPayload(error: unknown): { readonly error: string; readonly errorName: string } {
	return {
		error: error instanceof Error ? error.message : String(error),
		errorName: error instanceof Error ? error.name : 'Error'
	};
}

async function openRuntimeFile(root: vscode.Uri | undefined, path: string): Promise<Uint8Array> {
	const normalized = normalizeRuntimeFilePath(path);
	if (!root || !normalized) {
		throw createRuntimeFileNotFoundError(path);
	}
	const uri = vscode.Uri.joinPath(root, ...normalized.split('/'));
	try {
		return await vscode.workspace.fs.readFile(uri);
	} catch {
		throw createRuntimeFileNotFoundError(path);
	}
}

async function writeRuntimeFile(root: vscode.Uri | undefined, path: string, content: Uint8Array): Promise<void> {
	const normalized = normalizeRuntimeFilePath(path);
	if (!root || !normalized) {
		throw createRuntimeFileNotFoundError(path);
	}
	await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(root, ...normalized.split('/')), content);
}

function parentUri(uri: vscode.Uri): vscode.Uri {
	const index = uri.path.lastIndexOf('/');
	if (index <= 0) {
		return uri;
	}
	return uri.with({ path: uri.path.slice(0, index) });
}

function cleanErrorMessage(error: unknown): string {
	if (error instanceof Error) {
		return error.message || error.name;
	}
	return String(error);
}

function cleanJavaErrorMessage(error: unknown): string {
	const message = cleanErrorMessage(error);
	return message === '(could not fetch message)'
		? 'Java exception was thrown, but Throwable.getMessage() returned null.'
		: message;
}

function hasWasmExport(wasmBytes: Uint8Array, name: string): boolean {
	try {
		const bytes = wasmBytes.slice();
		const module = new WebAssembly.Module(bytes);
		return WebAssembly.Module.exports(module).some(entry => entry.name === name);
	} catch {
		return false;
	}
}

class Extension implements vscode.Disposable {
	private readonly disposables: vscode.Disposable[] = [];
	private readonly output = vscode.window.createOutputChannel('Processing');	// output channel
	private readonly controlsProvider: ExtensionControlsProvider;	// control panel
	private readonly linter: ProcessingLinter;
	private readonly assignmentViewProvider: AssignmentViewProvider;
	private readonly assignmentBrowserProvider: AssignmentBrowserProvider;
	private readonly exporter: WebsiteExporter;
	private runtimePanel: ProcessingRuntimePanel | undefined;	// runtime panel
	private referencePanel: ProcessingReferencePanel | undefined;
	private javaRuntimeWorker: Worker | undefined;
	private javaRuntimeRunId = 0;
	private javaRuntimeRoot: vscode.Uri | undefined;
	private mode: SourceKind = 'processing';
	private assignments: readonly AssignmentCatalogItem[] = [];
	private assignmentsLoading = false;
	private assignmentsError = '';
	private buildArtifact: BuildArtifact | undefined;
	private compiling = false;
	private running = false;

	constructor(private readonly context: vscode.ExtensionContext) {
		this.controlsProvider = new ExtensionControlsProvider(this.context.extensionUri, this);
		this.linter = new ProcessingLinter(context);
		this.assignmentViewProvider = new AssignmentViewProvider(context.extensionUri, this);
		this.exporter = new WebsiteExporter(
			context.extensionUri,
			new ProcessingCompiler(context.extensionUri, message => this.log(message)),
			String(context.extension.packageJSON.version ?? ''),
			message => this.log(message)
		);
		this.assignmentBrowserProvider = new AssignmentBrowserProvider(context.extensionUri, {
			getState: () => this.getAssignmentBrowserState(),
			openAssignment: id => this.openCatalogAssignment(id)
		});
		this.disposables.push(this.output);
		this.disposables.push(this.linter);
		this.disposables.push(vscode.window.registerCustomEditorProvider(AssignmentViewProvider.viewType, this.assignmentViewProvider, {
			webviewOptions: { retainContextWhenHidden: true }
		}));
		this.disposables.push(vscode.window.registerWebviewViewProvider(controlsViewType, this.controlsProvider, {
			webviewOptions: { retainContextWhenHidden: true }
		}));
		this.disposables.push(vscode.window.registerWebviewViewProvider(assignmentBrowserViewType, this.assignmentBrowserProvider, {
			webviewOptions: { retainContextWhenHidden: true }
		}));
		// commands
		this.disposables.push(vscode.commands.registerCommand(compileCommand, () => this.compile()));
		this.disposables.push(vscode.commands.registerCommand(runCommand, () => this.run()));
		this.disposables.push(vscode.commands.registerCommand(stopCommand, () => this.stop()));
		this.disposables.push(vscode.commands.registerCommand(exportWebsiteCommand, () => this.exportWebsite()));
		this.disposables.push(vscode.commands.registerCommand(openReferenceCommand, () => this.openReference()));
		this.disposables.push(vscode.commands.registerCommand(openApcsaReferenceCommand, () => this.openApcsaReference()));
		this.disposables.push(vscode.commands.registerCommand(refreshAssignmentsCommand, () => this.loadAssignmentCatalog()));
		// events
		this.disposables.push(vscode.workspace.onDidChangeWorkspaceFolders(() => this.refreshState()));
		this.disposables.push(vscode.workspace.onDidOpenTextDocument(() => this.refreshState()));
		this.disposables.push(vscode.workspace.onDidChangeTextDocument(() => this.refreshState()));
		this.disposables.push(vscode.workspace.onDidDeleteFiles(() => this.refreshState()));
		this.disposables.push(vscode.workspace.onDidCreateFiles(() => this.refreshState()));
		void vscode.commands.executeCommand('setContext', 'webprocessing.assignmentsEnabled', assignmentsEnabled);
		void vscode.commands.executeCommand('setContext', 'webprocessing.exportWebsiteEnabled', exportWebsiteEnabled);
		void this.refreshState();
		void this.openControlView();
		if (assignmentsEnabled) {
			void this.loadAssignmentCatalog();
		}
	}

	dispose(): void {
		this.stop();
		// kill all evilness
		for (const disposable of this.disposables) {
			disposable.dispose();
		}
		this.runtimePanel?.dispose();
		this.referencePanel?.dispose();
	}

	getState(): ExtensionState {
		return {
			mode: this.mode,
			hasSources: hasSources(this.mode),
			hasCompiled: !!this.buildArtifact,
			isCompiling: this.compiling,
			isRunning: this.running,
			isOutdated: !!this.buildArtifact?.outdated
		};
	}

	private async refreshState(): Promise<void> {
		const workspaceFolder = getWorkspaceFolder();
		let buildArtifact: BuildArtifact | undefined;
		if (workspaceFolder) {
			// see if the compiled file exists and if it's outdated
			const uri = buildArtifactFileUri(workspaceFolder);
			const stat = await statOrUndefined(uri);
			if (stat) {
				buildArtifact = {
					mode: this.mode,
					scope: workspaceFolder.uri.toString(),
					name: buildArtifactFileName(workspaceFolder),
					uri,
					outdated: await isBuildArtifactOutdated(workspaceFolder, stat.mtime)
				};
			}
		} else if (this.buildArtifact?.bytes && this.buildArtifact.sourceVersions) {
			buildArtifact = {
				...this.buildArtifact,
				outdated: isTempBuildArtifactOutdated(this.buildArtifact.sourceVersions)
			};
		}

		this.buildArtifact = buildArtifact;
		await vscode.commands.executeCommand('setContext', 'webprocessing.hasCompiled', !!buildArtifact);
		await vscode.commands.executeCommand('setContext', 'webprocessing.isCompiling', this.compiling);
		await vscode.commands.executeCommand('setContext', 'webprocessing.isRunning', this.running);
		this.controlsProvider.update();
	}

	setMode(mode: SourceKind): void {
		if (this.mode === mode || this.compiling || this.running) {
			return;
		}
		this.mode = mode;
		this.buildArtifact = undefined;
		void this.refreshState();
	}

	private showOutput(): void {
		this.output.show(true);
	}

	private log(message = ''): void {
		this.output.appendLine(message);
	}

	private appendOutput(message = ''): void {
		this.output.append(message);
	}

	// open the control panel (on first activation)
	private async openControlView(): Promise<void> {
		if (this.context.globalState.get<boolean>(defaultOpenStateKey)) {
			return;
		}
		await this.context.globalState.update(defaultOpenStateKey, true);
		await new Promise(resolve => setTimeout(resolve, 500));
		await vscode.commands.executeCommand(`${controlsViewType}.focus`);
	}

	async startAssignment(assignment: CsptAssignment): Promise<void> {
		if (await this.writeAssignmentFiles(assignment)) {
			void vscode.window.showInformationMessage(vscode.l10n.t('Assignment started.'));
		}
	}

	async restartAssignment(assignment: CsptAssignment): Promise<void> {
		const restartLabel = vscode.l10n.t('Restart Assignment');
		const confirmed = await vscode.window.showWarningMessage(
			vscode.l10n.t('Restarting this assignment will overwrite template files in the workspace. Continue?'),
			{ modal: true },
			restartLabel
		);
		if (confirmed !== restartLabel) {
			return;
		}
		if (await this.writeAssignmentFiles(assignment)) {
			void vscode.window.showInformationMessage(vscode.l10n.t('Assignment restarted.'));
		}
	}

	async downloadAssignment(assignment: CsptAssignment, bytes: Uint8Array): Promise<vscode.Uri | undefined> {
		const target = await this.assignmentTarget(assignment);
		if (!target) {
			return undefined;
		}
		const fileName = `${assignment.id.replace(/[^a-zA-Z0-9._-]/g, '-')}.cspt`;
		const uri = vscode.Uri.joinPath(target.uri, fileName);
		await vscode.workspace.fs.writeFile(uri, bytes);
		return uri;
	}

	private async writeAssignmentFiles(assignment: CsptAssignment): Promise<boolean> {
		const target = await this.assignmentTarget(assignment);
		if (!target) {
			return false;
		}

		const unpacker = await loadCsptUnpacker(this.context.extensionUri, assignment.uri);
		const templateFiles = await unpacker.templateFiles();
		const readme = templateFiles.find(file => file.path.toLowerCase() === 'readme.md');
		this.showOutput();
		this.log(`[assignment] Starting ${assignment.id}`);
		for (const file of templateFiles) {
			await this.writeAssignmentTemplate(target, file.path, file.bytes);
			this.log(`[assignment] Wrote ${file.path}`);
		}
		await writeAssignmentData(target, {
			id: assignment.id,
			displayName: assignment.displayName,
			bundleUri: assignment.uri.toString(),
			startedAt: new Date().toISOString()
		});
		this.mode = 'java';
		await this.refreshState();
		if (readme) {
			await vscode.commands.executeCommand('markdown.showPreview', assignmentPath(target, readme.path));
		}
		return true;
	}

	private async assignmentTarget(assignment: CsptAssignment): Promise<AssignmentTarget | undefined> {
		const workspaceFolder = getWorkspaceFolder();
		if (workspaceFolder) {
			return workspaceFolder;
		}

		const name = this.assignmentWorkspaceName(assignment);
		const uri = vscode.Uri.joinPath(this.context.globalStorageUri, 'assignment-workspaces', this.assignmentStorageFolderName(assignment));
		await vscode.workspace.fs.createDirectory(uri);

		const existing = this.findWorkspaceFolder(uri);
		if (existing) {
			return existing;
		}

		const added = vscode.workspace.updateWorkspaceFolders(vscode.workspace.workspaceFolders?.length ?? 0, 0, { uri, name });
		if (!added) {
			void vscode.window.showWarningMessage(vscode.l10n.t('Could not create a workspace folder for this assignment.'));
			return undefined;
		}

		return await this.waitForWorkspaceFolder(uri) ?? { uri, name };
	}

	private assignmentWorkspaceName(assignment: CsptAssignment): string {
		return assignment.displayName.trim() || assignment.id || 'Assignment';
	}

	private assignmentStorageFolderName(assignment: CsptAssignment): string {
		return assignment.id.replace(/[^a-zA-Z0-9._-]/g, '-') || 'assignment';
	}

	private findWorkspaceFolder(uri: vscode.Uri): vscode.WorkspaceFolder | undefined {
		return vscode.workspace.workspaceFolders?.find(folder => folder.uri.toString() === uri.toString());
	}

	private async waitForWorkspaceFolder(uri: vscode.Uri): Promise<vscode.WorkspaceFolder | undefined> {
		const existing = this.findWorkspaceFolder(uri);
		if (existing) {
			return existing;
		}
		return new Promise(resolve => {
			const disposable = vscode.workspace.onDidChangeWorkspaceFolders(() => {
				const folder = this.findWorkspaceFolder(uri);
				if (folder) {
					disposable.dispose();
					resolve(folder);
				}
			});
			setTimeout(() => {
				disposable.dispose();
				resolve(this.findWorkspaceFolder(uri));
			}, 1000);
		});
	}

	async openCatalogAssignment(key: string): Promise<void> {
		const assignment = this.assignments.find(item => item.catalogKey === key);
		if (!assignment) {
			return;
		}
		try {
			const response = await fetch(this.assignmentStoreUrl(assignment.storeUrl, `${encodeURIComponent(assignment.id)}.cspt`));
			if (!response.ok) {
				throw new Error(`HTTP ${response.status}`);
			}
			const bytes = new Uint8Array(await response.arrayBuffer());
			await this.assignmentViewProvider.openPreview(assignment.id, bytes);
		} catch (error) {
			void vscode.window.showErrorMessage(vscode.l10n.t('Failed to open assignment: {0}', String(error)));
		}
	}

	async openAssignmentBrowser(): Promise<void> {
		await vscode.commands.executeCommand(`${assignmentBrowserViewType}.focus`);
	}

	private getAssignmentBrowserState(): AssignmentBrowserViewState {
		return {
			assignments: this.assignments,
			loading: this.assignmentsLoading,
			error: this.assignmentsError
		};
	}

	private async loadAssignmentCatalog(): Promise<void> {
		this.assignmentsLoading = true;
		this.assignmentsError = '';
		this.controlsProvider.update();
		this.assignmentBrowserProvider.update();
		try {
			const stores = this.assignmentStoreUrls();
			const assignments: AssignmentCatalogItem[] = [];
			const errors: string[] = [];
			for (const [index, storeUrl] of stores.entries()) {
				try {
					assignments.push(...await this.loadAssignmentCatalogFromStore(storeUrl, index));
				} catch (error) {
					errors.push(`${storeUrl}: ${String(error)}`);
				}
			}
			if (!assignments.length && errors.length) {
				throw new Error(errors.join('\n'));
			}
			this.assignments = assignments;
		} catch (error) {
			this.assignmentsError = String(error);
		} finally {
			this.assignmentsLoading = false;
			this.controlsProvider.update();
			this.assignmentBrowserProvider.update();
		}
	}

	private async loadAssignmentCatalogFromStore(storeUrl: string, storeIndex: number): Promise<AssignmentCatalogItem[]> {
		const response = await fetch(this.assignmentStoreUrl(storeUrl, 'catalog.json'));
		if (!response.ok) {
			throw new Error(`HTTP ${response.status}`);
		}
		const catalog = await response.json() as AssignmentCatalogEntry[];
		return catalog
			.filter(item =>
				typeof item.id === 'string'
				&& typeof item.name === 'string'
				&& typeof item.descriptionPreview === 'string'
			)
			.map(item => ({
				...item,
				storeUrl,
				catalogKey: `${storeIndex}:${item.id}`
			}));
	}

	private assignmentStoreUrls(): string[] {
		const configured = vscode.workspace.getConfiguration('webprocessing').get<readonly string[]>('assignmentStoreUrls') ?? [];
		const urls = configured.map(url => url.trim()).filter(Boolean);
		return urls.length ? urls : defaultAssignmentStoreUrls;
	}

	private assignmentStoreUrl(baseUrl: string, path: string): string {
		return new URL(path, baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`).toString();
	}

	async evaluateAssignment(assignment: CsptAssignment): Promise<void> {
		const workspaceFolder = getWorkspaceFolder();
		if (!workspaceFolder) {
			void vscode.window.showWarningMessage(vscode.l10n.t('Open a workspace folder before evaluating an assignment.'));
			return;
		}

		this.showOutput();
		this.output.clear();
		this.setCompiling(true);
		this.setRunning(true);
		this.log('\n==== BEGIN ASSIGNMENT EVALUATION ====\n');
		this.log(`[assignment] ${assignment.id}`);
		const results: CsptCheckResult[] = [];
		try {
			for (const check of assignment.checks) {
				const result = check.type === 'validator'
					? await this.evaluateValidatorCheck(workspaceFolder, check)
					: await this.evaluateCompileCheck(workspaceFolder, check);
				results.push(result);
				this.log(`[assignment] ${result.passed ? 'PASS' : 'FAIL'} ${result.displayName}`);
				if (!result.passed && result.reason) {
					this.log(`[assignment] ${result.reason}`);
				}
			}

			const previous = await readAssignmentData(workspaceFolder);
			await writeAssignmentData(workspaceFolder, {
				id: assignment.id,
				displayName: assignment.displayName,
				bundleUri: assignment.uri.toString(),
				startedAt: previous?.startedAt ?? new Date().toISOString(),
				evaluatedAt: new Date().toISOString(),
				results
			});
			this.log('\n==== ASSIGNMENT EVALUATION FINISHED ====\n');
		} finally {
			this.setRunning(false);
			this.setCompiling(false);
			await this.refreshState();
		}
	}

	private async evaluateCompileCheck(workspaceFolder: vscode.WorkspaceFolder, check: CompileCheck): Promise<CsptCheckResult> {
		try {
			const sources = await this.collectAssignmentSources(workspaceFolder);
			await this.compileJavaOnly(sources, check.hidden);
			return this.assignmentResult(check, true);
		} catch (error) {
			return this.assignmentResult(check, false, check.hidden ? undefined : cleanErrorMessage(error));
		}
	}

	private async evaluateValidatorCheck(workspaceFolder: vscode.WorkspaceFolder, check: ValidatorCheck): Promise<CsptCheckResult> {
		try {
			const sources = [
				...await this.collectAssignmentSources(workspaceFolder),
				...Object.entries(check.files).map(([path, content]) => ({
					uri: vscode.Uri.parse(`cspt-validator:/${path}`),
					path,
					content
				}))
			];
			const mainSource = this.findValidatorEntrypoint(sources, check);
			const wasmBytes = await this.compileJava(sources, mainSource, `${check.id}.wasm`, check.mainClass, check.hidden);
			const run = await this.runJavaProgram(wasmBytes, check.args ?? [], check.timeoutMs, check.hidden);
			const failed = run.stderr.trim().length > 0 || run.error !== undefined;
			return this.assignmentResult(check, !failed, check.hidden ? undefined : (run.error ?? run.stderr.trim()) || undefined);
		} catch (error) {
			return this.assignmentResult(check, false, check.hidden ? undefined : cleanErrorMessage(error));
		}
	}

	private async collectAssignmentSources(workspaceFolder: vscode.WorkspaceFolder): Promise<readonly WorkspaceSource[]> {
		const collection = await collectSources('java');
		const sources = collection.sources.filter(source => isInWorkspaceFolder(source.uri, workspaceFolder));
		if (!sources.length) {
			throw new Error('No Java source files were found.');
		}
		return sources;
	}

	private findValidatorEntrypoint(sources: readonly WorkspaceSource[], check: ValidatorCheck): WorkspaceSource {
		const expected = `${check.mainClass.replace(/\./g, '/')}.java`;
		const found = sources.find(source => source.path === expected || stripExtension(source.path.split('/').pop() ?? '') === check.mainClass.split('.').pop());
		if (!found) {
			throw new Error(`Validator entrypoint not found: ${check.mainClass}`);
		}
		return found;
	}

	private assignmentResult(check: CompileCheck | ValidatorCheck, passed: boolean, reason?: string): CsptCheckResult {
		const name = check.displayName ?? check.id;
		return {
			id: check.id,
			type: check.type,
			displayName: check.hidden ? 'Hidden check' : `${check.id}: ${name}`,
			description: check.hidden ? undefined : check.description,
			hidden: !!check.hidden,
			passed,
			evaluatedAt: new Date().toISOString(),
			reason
		};
	}

	private async runJavaProgram(wasmBytes: Uint8Array, args: readonly string[], timeoutMs: number | undefined, quiet = false): Promise<{ stdout: string; stderr: string; error?: string }> {
		const module = await this.loadJavaCompilerModule();
		let stdout = '';
		let stderr = '';
		const hasExceptionMessage = hasWasmExport(wasmBytes, 'teavm.exceptionMessage');
		const hasStringToJs = hasWasmExport(wasmBytes, 'teavm.stringToJs');
		try {
			const program = await module.createJavaProgram(wasmBytes, {
				wasmRuntimeUrl: this.assetImportUri('compiler.wasm-runtime.js'),
				stdio: {
					stdin: '',
					stdout: text => { stdout += text; },
					stderr: text => { stderr += text; }
				},
				fs: {
					onFileWrite: (path, content) => {
						void writeRuntimeFile(getWorkspaceFolder()?.uri, path, content);
					},
					onFileClose: (path, _mode, content) => {
						if (content) {
							void writeRuntimeFile(getWorkspaceFolder()?.uri, path, content);
						}
					}
				}
			});
			await program.execute({
				args: [...args],
				timeoutMs
			});
			return { stdout, stderr };
		} catch (error) {
			const message = cleanJavaErrorMessage(error);
			if (!quiet && cleanErrorMessage(error) === '(could not fetch message)') {
				this.log(`[assignment] Java exception message exports: teavm.exceptionMessage=${hasExceptionMessage}, teavm.stringToJs=${hasStringToJs}`);
			}
			return { stdout, stderr, error: message };
		}
	}

	private async writeAssignmentTemplate(target: AssignmentTarget, path: string, bytes: Uint8Array): Promise<void> {
		const uri = assignmentPath(target, path);
		const folder = parentUri(uri);
		if (folder.toString() !== target.uri.toString()) {
			await vscode.workspace.fs.createDirectory(folder);
		}
		await vscode.workspace.fs.writeFile(uri, bytes);
	}

	/** Compiles the sketch to WebAssembly and JavaScript and writes a standalone website next to it. */
	async exportWebsite(): Promise<void> {
		if (this.compiling || this.running) {
			return;
		}
		this.setCompiling(true);
		this.showOutput();
		this.output.clear();
		try {
			await this.exporter.export();
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.log(`[export] ${message}`);
			void vscode.window.showErrorMessage(vscode.l10n.t('Website export failed: {0}', message));
		} finally {
			this.setCompiling(false);
		}
	}

	async compile(): Promise<void> {
		if (this.compiling || this.running) {
			return;
		}
		this.setCompiling(true);
		const startedAt = Date.now();

		this.showOutput();
		this.output.clear();
		this.log('\n==== BEGIN COMPILATION ====\n');
		this.log(`[compiler] Mode: ${this.mode}`);
		this.log('[compiler] Target configuration: type=WebAssembly (Wasm-GC), fast global analysis enabled');

		try {
			// collect
			this.log('\n[compiler] collecting source files...');
			const collection = await collectSources(this.mode);
			const { sources } = collection;
			if (sources.length === 0) {
				throw new Error(`No ${this.mode === 'processing' ? '.pde' : '.java'} files were found.`);
			}

			for (const source of sources) {
				this.log(`[compiler] Found ${source.path} (${countLines(source.content)} lines, ${source.content.length} chars)`);
			}

			const workspaceFolder = collection.workspaceFolders[0];
			const entrypoint = identifyEntrypoint(sources, workspaceFolder);
			if (!entrypoint && sources.length > 1) {
				throw new Error('Cannot determine program entrypoint for a multi-file project. Use foldername.pde, foldername.java, main.pde, or main.java.');
			}
			const mainSource = entrypoint ?? sources[0];
			this.log(`[compiler] Entrypoint: ${mainSource.path}`);

			const targetFileName = workspaceFolder ? buildArtifactFileName(workspaceFolder) : `${stripExtension(mainSource.path ?? 'sketch')}.compiled.wasm`;
			const targetUri = workspaceFolder ? buildArtifactFileUri(workspaceFolder) : undefined;

			const wasmBytes = this.mode === 'processing'
				? await this.compileProcessing(sources, mainSource, targetFileName)
				: await this.compileJava(sources, mainSource, targetFileName);

			if (targetUri && workspaceFolder) {
				await vscode.workspace.fs.writeFile(targetUri, wasmBytes);
				this.buildArtifact = {
					mode: this.mode,
					scope: workspaceFolder.uri.toString(),
					name: targetFileName,
					uri: targetUri,
					outdated: false
				};
				this.log(`[compiler] Wrote ${targetFileName} (${wasmBytes.byteLength} bytes).`);
			} else {
				this.buildArtifact = {
					mode: this.mode,
					scope: 'open-tabs',
					name: targetFileName,
					bytes: wasmBytes,
					sourceVersions: sourceVersions(sources),
					outdated: false
				};
				this.log(`[compiler] Stored ${targetFileName} in temporary memory (${wasmBytes.byteLength} bytes).`);
			}

			this.log(`\n==== BUILD SUCCEEDED in ${formatDuration(Date.now() - startedAt)} ====\n`);
			await this.refreshState();
		} catch (error) {
			// check if error.issues is exists, then list
			if (error.issues) {
				for (const issue of error.issues) {
					this.log(`[compiler] ${issue.message}`);
				}
			} else {
				this.log(`[compiler] ${error}`);
			}

			this.log(`\n==== BUILD FAILED in ${formatDuration(Date.now() - startedAt)} ====\n`);
			void vscode.window.showErrorMessage(vscode.l10n.t('Processing compile failed. See the Processing output channel.'));
			await this.refreshState();
		} finally {
			this.setCompiling(false);
		}
	}

	private async compileProcessing(sources: readonly WorkspaceSource[], mainSource: WorkspaceSource, targetFileName: string): Promise<Uint8Array> {
		this.log('\n[compiler] Loading Processing compiler...');
		const processing = await this.loadProcessingCompilerModule();
		const core = await this.readAsset('processing-core-teavm.jar');

		this.log('[compiler] Compiling Processing sketch...');
		const generated = await processing.generateProcessingSketch([...sources], {
			core,
			sketchName: toJavaIdentifier(stripExtension(mainSource.path ?? 'Sketch'), 'Sketch'),
			sourceMaps: false,
			target: 'webassembly',
			output: 'webassembly',
			backend: 'canvas2d',
			optimizationLevel: 'simple',
			fastGlobalAnalysis: true,
			worker: false,
			wasmOutputName: stripWasmExtension(targetFileName),
			compilerOptions: this.compilerOptions(),
			onDiagnostic: diagnostic => {
				this.log(formatDiagnostic(diagnostic));
			}
		});

		if (generated.output !== 'wasm-gc' || !generated.wasmBytes) {
			throw new Error('TeaVM did not produce a valid WebAssembly output.');
		}
		if (generated.files?.length) {
			this.log(`[compiler] Generated files: ${generated.files.join(', ')}`);
		}
		return generated.wasmBytes;
	}

	private async compileJavaOnly(sources: readonly WorkspaceSource[], quiet = false): Promise<void> {
		this.log('\n[compiler] Loading Java compiler...');
		const module = await this.loadJavaCompilerModule();
		const compiler = await module.createCompiler(this.compilerOptions());
		const diagnostics = compiler.onDiagnostic(diagnostic => {
			if (!quiet) {
				this.log(formatDiagnostic(diagnostic));
			}
		});

		try {
			for (const source of sources) {
				compiler.addSource(source.path, source.content);
			}

			this.log('[compiler] Compiling Java sources...');
			if (!compiler.compile()) {
				throw new Error('Java compilation failed.');
			}
		} finally {
			diagnostics.dispose();
		}
	}

	private async compileJava(sources: readonly WorkspaceSource[], mainSource: WorkspaceSource, targetFileName: string, mainClassOverride?: string, quiet = false): Promise<Uint8Array> {
		this.log('\n[compiler] Loading Java compiler...');
		const module = await this.loadJavaCompilerModule();
		const compiler = await module.createCompiler(this.compilerOptions());
		const diagnostics = compiler.onDiagnostic(diagnostic => {
			if (!quiet) {
				this.log(formatDiagnostic(diagnostic));
			}
		});

		try {
			for (const source of sources) {
				compiler.addSource(source.path, source.content);
			}

			this.log('[compiler] Compiling Java sources...');
			if (!compiler.compile()) {
				throw new Error('Java compilation failed.');
			}

			const mainClass = mainClassOverride ?? this.resolveJavaMainClass(compiler.findMainClasses(), mainSource);
			if (!quiet) {
				this.log(`[compiler] Main class: ${mainClass}`);
			}
			const emitted = compiler.emitWasm({
				mainClass,
				outputName: stripWasmExtension(targetFileName),
				optimizationLevel: 'simple',
				fastGlobalAnalysis: true
			});

			if (!emitted.ok || !emitted.bytes) {
				throw new Error('TeaVM did not produce a valid WebAssembly output.');
			}
			if (!quiet && emitted.files.length) {
				this.log(`[compiler] Generated files: ${emitted.files.join(', ')}`);
			}
			return new Uint8Array(emitted.bytes);
		} finally {
			diagnostics.dispose();
		}
	}

	private resolveJavaMainClass(mainClasses: readonly string[], mainSource: WorkspaceSource): string {
		if (mainClasses.length === 0) {
			throw new Error('No Java main class was found.');
		}
		const sourceClass = toJavaIdentifier(stripExtension(mainSource.path ?? 'Main').split('/').pop() ?? 'Main', 'Main');
		const matched = mainClasses.find(candidate => candidate === sourceClass || candidate.endsWith(`.${sourceClass}`));
		if (matched) {
			return matched;
		}
		if (mainClasses.length === 1) {
			return mainClasses[0];
		}
		throw new Error(`Multiple Java main classes found: ${mainClasses.join(', ')}. Use main.java or the workspace folder name for the entrypoint.`);
	}

	async run(): Promise<void> {
		if (this.compiling || this.running) {
			return;
		}

		await this.refreshState();
		const artifact = this.buildArtifact;
		if (!artifact || artifact.mode !== this.mode) {
			void vscode.window.showWarningMessage(vscode.l10n.t('Compile before running.'));
			await this.refreshState();
			return;
		}

		// run java
		if (this.mode === 'java') {
			return this.runJavaInBackground(artifact);
		}

		// run processing
		this.showOutput();
		if (artifact.outdated) {
			this.log('[runtime] Warning: Running an outdated executable. The output may not include your latest saved or unsaved changes.');
		}
		this.log(`[runtime] Running ${artifact.name}...`);

		// if there's no runtime panel or the current one is not for the workspace folder, create a new one
		if (!this.runtimePanel || !this.runtimePanel.checkScope(artifact.scope)) {
			this.runtimePanel?.dispose();
			this.runtimePanel = new ProcessingRuntimePanel(this.context.extensionUri, artifact.scope, artifact.uri ? getWorkspaceFolder()?.uri : undefined, message => this.handleRuntimeMessage(message), () => {
				this.runtimePanel = undefined;
				this.setRunning(false);
			});
		}

		const didStartRuntime = await this.runtimePanel.run(artifact.uri ? { uri: artifact.uri } : { bytes: artifact.bytes! });
		if (!didStartRuntime) {
			await this.refreshState();
			return;
		}
		this.setRunning(true);
		await this.refreshState();
	}

	private async runJavaInBackground(artifact: BuildArtifact): Promise<void> {
		this.showOutput();
		if (artifact.outdated) {
			this.log('[runtime] Warning: Running an outdated executable. The output may not include your latest saved or unsaved changes.');
		}
		this.log(`[runtime] Running ${artifact.name}...\n`);
		this.stopJavaRuntime(false);
		this.setRunning(true);
		await this.refreshState();

		try {
			const runId = ++this.javaRuntimeRunId;
			this.javaRuntimeRoot = artifact.uri ? getWorkspaceFolder()?.uri : undefined;
			const sourceBytes = artifact.bytes ?? await vscode.workspace.fs.readFile(artifact.uri!);
			const wasmBytes = new Uint8Array(sourceBytes);
			const worker = new Worker(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'java-runtime-worker.js').toString(), {
				name: 'webprocessing-java-runtime'
			});
			this.javaRuntimeWorker = worker;
			worker.onmessage = event => this.handleJavaRuntimeMessage(runId, event.data);
			worker.onerror = event => {
				if (runId !== this.javaRuntimeRunId) {
					return;
				}
				this.log(`[runtime] ${event.message}`);
				this.stopJavaRuntime(false);
				this.setRunning(false);
				void this.refreshState();
			};
			worker.postMessage({
				type: 'run',
				runtimeUri: this.assetImportUri('compiler.wasm-runtime.js'),
				compilerUri: this.assetImportUri('teavm-javac.js'),
				wasmBytes
			}, [wasmBytes.buffer]);
		} catch (error) {
			this.log(`[runtime] ${error}`);
			void vscode.window.showErrorMessage(vscode.l10n.t('Java runtime failed. See the Processing output channel.'));
			this.setRunning(false);
			await this.refreshState();
		}
	}

	stop(): void {
		const stoppedProcessingRuntime = this.mode === 'processing' && this.running && !!this.runtimePanel;
		this.runtimePanel?.stop();
		this.stopJavaRuntime();
		if (stoppedProcessingRuntime) {
			this.showOutput();
			this.log('[runtime] Runtime stopped.');
		}
		this.setRunning(false);
	}

	async openReference(): Promise<void> {
		await this.openReferencePanel('Processing Reference', 'https://processing.org/reference/');
	}

	async openApcsaReference(): Promise<void> {
		await this.openReferencePanel('APCSA Reference', vscode.Uri.joinPath(this.context.extensionUri, 'media', 'reference', 'ap-computer-science-a-java-quick-reference.pdf'));
	}

	private async openReferencePanel(title: string, source: string | vscode.Uri): Promise<void> {
		if (!this.referencePanel) {
			this.referencePanel = new ProcessingReferencePanel(this.context.extensionUri, () => {
				this.referencePanel = undefined;
			});
		}
		await this.referencePanel.open(title, source);
	}

	private handleJavaRuntimeMessage(runId: number, message: { readonly type?: string; readonly text?: string; readonly requestId?: number; readonly path?: string; readonly mode?: string; readonly content?: Uint8Array }): void {
		if (runId !== this.javaRuntimeRunId) {
			return;
		}
		switch (message.type) {
			case 'file-open':
				void this.replyJavaRuntimeFileOpen(message.requestId, message.path);
				break;
			case 'file-write':
			case 'file-close':
				void this.writeJavaRuntimeFile(message.path, message.content);
				break;
			case 'stdout':
			case 'stderr':
				this.showOutput();
				this.appendOutput(message.text ?? '');
				break;
			case 'log':
				this.showOutput();
				this.log(`${message.text ?? ''}`);
				break;
			case 'finished':
				this.showOutput();
				this.log('[runtime] Runtime finished.');
				this.stopJavaRuntime(false);
				this.setRunning(false);
				void this.refreshState();
				break;
			case 'error':
				this.showOutput();
				this.log(`[runtime] ${message.text ?? 'Runtime failed.'}`);
				this.stopJavaRuntime(false);
				this.setRunning(false);
				void this.refreshState();
				void vscode.window.showErrorMessage(vscode.l10n.t('Java runtime failed. See the Processing output channel.'));
				break;
		}
	}

	private async writeJavaRuntimeFile(path: string | undefined, content: Uint8Array | undefined): Promise<void> {
		if (!path || !content) {
			return;
		}
		try {
			await writeRuntimeFile(this.javaRuntimeRoot, path, content);
		} catch (error) {
			this.showOutput();
			this.log(`[runtime] ${error}`);
		}
	}

	private async replyJavaRuntimeFileOpen(requestId: number | undefined, path: string | undefined): Promise<void> {
		const worker = this.javaRuntimeWorker;
		if (requestId === undefined || !path || !worker) {
			return;
		}
		try {
			const bytes = await openRuntimeFile(this.javaRuntimeRoot, path);
			if (this.javaRuntimeWorker === worker) {
				worker.postMessage({ type: 'file-response', requestId, path, bytes }, [bytes.buffer]);
			}
		} catch (error) {
			if (this.javaRuntimeWorker === worker) {
				worker.postMessage({ type: 'file-response', requestId, path, ...runtimeFileErrorPayload(error) });
			}
		}
	}

	private stopJavaRuntime(log = true): void {
		if (!this.javaRuntimeWorker) {
			return;
		}
		this.javaRuntimeRunId++;
		this.javaRuntimeWorker.terminate();
		this.javaRuntimeWorker = undefined;
		this.javaRuntimeRoot = undefined;
		if (log) {
			this.showOutput();
			this.log('[runtime] Runtime stopped.');
		}
	}

	private setCompiling(compiling: boolean): void {
		this.compiling = compiling;
		void vscode.commands.executeCommand('setContext', 'webprocessing.isCompiling', compiling);
		this.controlsProvider.update();
	}

	private setRunning(running: boolean): void {
		this.running = running;
		void vscode.commands.executeCommand('setContext', 'webprocessing.isRunning', running);
		this.controlsProvider.update();
	}

	private handleRuntimeMessage(message: RuntimeMessage): void {
		switch (message.type) {
			case 'stdout':
			case 'stderr':
				this.showOutput();
				this.appendOutput(message.text);
				break;
			case 'log-raw':
				this.showOutput();
				this.log(`${message.text}`);
				break;
			case 'started':
				this.showOutput();
				this.log('[runtime] Runtime started.\n');
				this.setRunning(true);
				break;
			case 'stopped':
				this.showOutput();
				this.log('[runtime] Runtime stopped.');
				this.setRunning(false);
				break;
		}
	}

	private async loadProcessingCompilerModule(): Promise<ProcessingModule> {
		return processingCompilerPackage;
	}

	private async loadJavaCompilerModule(): Promise<CompilerModule> {
		return javaCompilerPackage;
	}

	private async readAsset(name: string): Promise<Uint8Array> {
		return vscode.workspace.fs.readFile(this.assetUri(name));
	}

	private compilerOptions(): CreateCompilerOptions {
		return {
			compilerWasmUrl: this.assetUri('compiler.wasm').toString(),
			compilerWasmRuntimeUrl: this.assetImportUri('compiler.wasm-runtime.js'),
			javacClasslibUrl: this.assetUri('compile-classlib-teavm.bin').toString(),
			runtimeClasslibUrl: this.assetUri('runtime-classlib-teavm.bin').toString(),
			fallbackToJs: false
		};
	}

	private assetUri(name: string): vscode.Uri {
		return teavmPackageUri(this.context.extensionUri, name);
	}

	private assetImportUri(name: string): string {
		return this.assetUri(name).toString();
	}
}

type controlsMessage =
	| { readonly type: 'compile' }
	| { readonly type: 'run' }
	| { readonly type: 'stop' }
	| { readonly type: 'exportWebsite' }
	| { readonly type: 'openAssignments' }
	| { readonly type: 'openReference' }
	| { readonly type: 'openApcsaReference' }
	| { readonly type: 'mode'; readonly mode: SourceKind };

// stuff in left side bar
class ExtensionControlsProvider implements vscode.WebviewViewProvider {
	private view: vscode.WebviewView | undefined;
	constructor(
		private readonly extensionUri: vscode.Uri,
		private readonly controller: Extension
	) { }

	async resolveWebviewView(webviewView: vscode.WebviewView): Promise<void> {
		this.view = webviewView;
		webviewView.webview.options = { enableScripts: true };
		webviewView.webview.html = await this.getHtml(this.getViewState());
		webviewView.webview.onDidReceiveMessage(message => this.handleMessage(message));
	}

	update(): void {
		void this.view?.webview.postMessage({ type: 'state', state: this.getViewState() });
	}

	private handleMessage(message: controlsMessage): void {
		switch (message.type) {
			case 'compile':
				void this.controller.compile();
				break;
			case 'run':
				void this.controller.run();
				break;
			case 'stop':
				this.controller.stop();
				break;
			case 'exportWebsite':
				void this.controller.exportWebsite();
				break;
			case 'openAssignments':
				void this.controller.openAssignmentBrowser();
				break;
			case 'openReference':
				void this.controller.openReference();
				break;
			case 'openApcsaReference':
				void this.controller.openApcsaReference();
				break;
			case 'mode':
				this.controller.setMode(message.mode);
				break;
		}
	}

	private getViewState(): ExtensionControlsViewState {
		const state = this.controller.getState();
		const status = !state.hasSources
			? `Open a ${state.mode === 'processing' ? 'Processing' : 'Java'} source file.`
			: state.isCompiling
				? 'Compiling sketch...'
				: state.isRunning
					? 'Running sketch...'
					: state.hasCompiled
						? 'Ready to run.'
						: 'Compile a sketch to create a WebAssembly executable.';
		return {
			...state,
			status,
			warning: state.hasCompiled && state.isOutdated ? 'Warning: outdated executable.' : '',
			assignmentsEnabled,
			exportWebsiteEnabled,
		};
	}

	// generate the HTML content for the control panel
	private async getHtml(state: ExtensionControlsViewState): Promise<string> {
		const nonce = createNonce();
		const initialState = escapeScriptJson(JSON.stringify(state));
		return renderTemplate(await readTemplate(this.extensionUri, 'processing-controls.html'), {
			nonce,
			initialState
		});
	}
}

interface AssignmentBrowserViewState {
	readonly assignments: readonly AssignmentCatalogItem[];
	readonly loading: boolean;
	readonly error: string;
}

type AssignmentBrowserMessage =
	| { readonly type: 'openAssignment'; readonly id: string };

interface AssignmentBrowserController {
	getState(): AssignmentBrowserViewState;
	openAssignment(id: string): Promise<void>;
}

class AssignmentBrowserProvider implements vscode.WebviewViewProvider {
	private view: vscode.WebviewView | undefined;
	constructor(
		private readonly extensionUri: vscode.Uri,
		private readonly controller: AssignmentBrowserController
	) { }

	async resolveWebviewView(webviewView: vscode.WebviewView): Promise<void> {
		this.view = webviewView;
		webviewView.webview.options = { enableScripts: true };
		webviewView.webview.html = await this.getHtml();
		webviewView.webview.onDidReceiveMessage(message => this.handleMessage(message));
	}

	update(): void {
		void this.view?.webview.postMessage({ type: 'state', state: this.controller.getState() });
	}

	private async handleMessage(message: AssignmentBrowserMessage): Promise<void> {
		switch (message.type) {
			case 'openAssignment':
				await this.controller.openAssignment(message.id);
				break;
		}
	}

	private async getHtml(): Promise<string> {
		const nonce = createNonce();
		return renderTemplate(await readTemplate(this.extensionUri, 'assignment-browser.html'), {
			nonce,
			initialState: escapeScriptJson(JSON.stringify(this.controller.getState()))
		});
	}
}

type RuntimeMessage =
	| { readonly type: 'log-raw'; readonly text: string; readonly runId?: number }
	| { readonly type: 'stdout'; readonly text: string; readonly runId?: number }
	| { readonly type: 'stderr'; readonly text: string; readonly runId?: number }
	| { readonly type: 'started'; readonly runId?: number }
	| { readonly type: 'stopped'; readonly runId?: number }
	| { readonly type: 'file-open'; readonly requestId?: number; readonly path?: string; readonly runId?: number }
	| { readonly type: 'file-write'; readonly path?: string; readonly content?: Uint8Array; readonly runId?: number }
	| { readonly type: 'file-close'; readonly path?: string; readonly mode?: string; readonly content?: Uint8Array | null; readonly runId?: number };

type RuntimeSource =
	| { readonly uri: vscode.Uri }
	| { readonly bytes: Uint8Array };

// a panel to show execution outcome
class ProcessingRuntimePanel implements vscode.Disposable {
	private readonly panel: vscode.WebviewPanel;
	private pendingBytes: Uint8Array | undefined;
	private runId = 0;

	constructor(
		private readonly extensionUri: vscode.Uri,
		private readonly scope: string,
		private readonly localRoot: vscode.Uri | undefined,
		private readonly onMessage: (message: RuntimeMessage) => void,
		onDispose: () => void
	) {
		this.panel = vscode.window.createWebviewPanel(runtimeViewType, 'Processing Runtime', vscode.ViewColumn.Beside, {
			enableScripts: true,
			retainContextWhenHidden: true,
			localResourceRoots: localRoot
				? [vscode.Uri.joinPath(teavmPackageUri(extensionUri, 'package.json'), '..'), localRoot]
				: [vscode.Uri.joinPath(teavmPackageUri(extensionUri, 'package.json'), '..')]
		});
		this.panel.webview.onDidReceiveMessage(message => {
			if (message?.runId !== undefined && message.runId !== this.runId) {
				return;
			}
			if (message?.type === 'readyForWasm') {
				if (this.pendingBytes) {
					void this.panel.webview.postMessage({ type: 'wasmBytes', bytes: this.pendingBytes });
				}
				return;
			}
			if (message?.type === 'file-open') {
				void this.replyFileOpen(message.requestId, message.path);
				return;
			}
			if (message?.type === 'file-write' || message?.type === 'file-close') {
				void this.writeFile(message.path, message.content ?? undefined);
				return;
			}
			this.onMessage(message);
		});
		this.panel.onDidDispose(onDispose);
	}

	checkScope(scope: string): boolean {
		return this.scope === scope;
	}

	dispose(): void {
		this.panel.dispose();
	}

	async run(source: RuntimeSource): Promise<boolean> {	// fill in the webview to run the sketch
		this.panel.reveal(vscode.ViewColumn.Beside);
		this.pendingBytes = 'bytes' in source ? source.bytes : undefined;
		const runId = ++this.runId;
		const html = await this.getHtml('uri' in source ? source.uri : undefined, runId);
		if (runId !== this.runId) {
			return false;
		}
		this.panel.webview.html = html;
		return true;
	}

	stop(): void {	// tell the runner inside of webview to shut
		this.runId++;
		this.pendingBytes = undefined;
		this.panel.webview.html = this.getStoppedHtml();
	}

	private async replyFileOpen(requestId: number | undefined, path: string | undefined): Promise<void> {
		if (requestId === undefined || !path) {
			return;
		}
		try {
			const bytes = await openRuntimeFile(this.localRoot, path);
			await this.panel.webview.postMessage({ type: 'file-response', requestId, path, bytes });
		} catch (error) {
			await this.panel.webview.postMessage({ type: 'file-response', requestId, path, ...runtimeFileErrorPayload(error) });
		}
	}

	private async writeFile(path: string | undefined, content: Uint8Array | undefined): Promise<void> {
		if (!path || !content) {
			return;
		}
		try {
			await writeRuntimeFile(this.localRoot, path, content);
		} catch (error) {
			this.onMessage({ type: 'log-raw', text: `${error}`, runId: this.runId });
		}
	}

	// generate the HTML content for the runtime panel
	private async getHtml(wasmUri: vscode.Uri | undefined, runId: number): Promise<string> {
		const nonce = createNonce();
		const payload = escapeScriptJson(JSON.stringify({
			runId,
			wasmUri: wasmUri ? this.panel.webview.asWebviewUri(wasmUri).toString() : '',
			wasmRuntimeUri: this.panel.webview.asWebviewUri(teavmPackageUri(this.extensionUri, 'compiler.wasm-runtime.js')).toString(),
			processingUri: this.panel.webview.asWebviewUri(teavmPackageUri(this.extensionUri, 'processing')).toString()
		}));
		return renderTemplate(await readTemplate(this.extensionUri, 'processing-runtime.html'), {
			nonce,
			payload,
			cspSource: this.panel.webview.cspSource
		});
	}

	private getStoppedHtml(): string {
		return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<style>
		html, body { height: 100%; margin: 0; overflow: hidden; background: var(--vscode-editor-background); color: var(--vscode-descriptionForeground); font-family: var(--vscode-font-family); }
		body { display: grid; place-items: end start; }
		#status { width: 100%; box-sizing: border-box; border-top: 1px solid var(--vscode-panel-border); padding: 6px 8px; font-size: 12px; }
	</style>
</head>
<body>
	<div id="status">Stopped.</div>
</body>
</html>`;
	}
}

class ProcessingReferencePanel implements vscode.Disposable {
	private readonly panel: vscode.WebviewPanel;

	constructor(
		private readonly extensionUri: vscode.Uri,
		onDispose: () => void
	) {
		this.panel = vscode.window.createWebviewPanel(referenceViewType, 'Reference', vscode.ViewColumn.Beside, {
			enableScripts: true,
			retainContextWhenHidden: true,
			localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')]
		});
		this.panel.onDidDispose(onDispose);
	}

	dispose(): void {
		this.panel.dispose();
	}

	async open(title: string, source: string | vscode.Uri): Promise<void> {
		this.panel.title = title;
		this.panel.reveal(vscode.ViewColumn.Beside);
		this.panel.webview.html = await this.getHtml(title, source);
	}

	private async getHtml(title: string, source: string | vscode.Uri): Promise<string> {
		const nonce = createNonce();
		const url = typeof source === 'string' ? source : this.panel.webview.asWebviewUri(source).toString();
		const isPdf = typeof source !== 'string' && source.path.toLowerCase().endsWith('.pdf');
		const payload = escapeScriptJson(JSON.stringify({
			title,
			url,
			kind: isPdf ? 'pdf' : 'web',
			pdfViewerPageUri: this.panel.webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'pdfjs', 'web', 'viewer.html')).toString()
		}));
		return renderTemplate(await readTemplate(this.extensionUri, 'processing-reference.html'), {
			nonce,
			payload,
			cspSource: this.panel.webview.cspSource
		});
	}
}
