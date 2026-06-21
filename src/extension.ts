import * as vscode from 'vscode';
import { MoonrakerClient } from './moonrakerClient';
import {
  createPrinterCompletionProvider,
  KlipperDiagnostics,
  PrinterObjectCache
} from './printerObjects';
import {
  getSelectionOrCurrentMacro,
  renderTemplate
} from './macroTools';
import { ConditionHintsController } from './conditionInlayHints';
import { createRealtimeHoverProvider } from './hoverProvider';
import {
  RenderPreviewProvider,
  showRenderedDocument,
  showRenderedPeek
} from './renderPreviewProvider';

let client: MoonrakerClient | undefined;
let objectCache: PrinterObjectCache | undefined;
let diagnostics: KlipperDiagnostics | undefined;
let statusBar: vscode.StatusBarItem | undefined;
let output: vscode.OutputChannel | undefined;
let renderPreviewProvider: RenderPreviewProvider | undefined;
let conditionHints: ConditionHintsController | undefined;
let conditionHintsRefreshInterval: NodeJS.Timeout | undefined;

export function activate(context: vscode.ExtensionContext): void {
  output = vscode.window.createOutputChannel('Klipper VSC');
  output.appendLine('Klipper VSC extension activated.');
  objectCache = new PrinterObjectCache();
  diagnostics = new KlipperDiagnostics(objectCache);
  renderPreviewProvider = new RenderPreviewProvider();
  conditionHints = new ConditionHintsController(objectCache, () => client?.isConnected ?? false, output);
  conditionHintsRefreshInterval = setInterval(() => {
    conditionHints?.refresh();
  }, 1000);

  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBar.command = 'klipper.connectMoonraker';
  statusBar.text = 'Klipper: disconnected';
  statusBar.tooltip = 'Connect to Moonraker';
  statusBar.show();

  context.subscriptions.push(
    output,
    statusBar,
    diagnostics,
    renderPreviewProvider,
    conditionHints,
    new vscode.Disposable(() => {
      if (conditionHintsRefreshInterval) {
        clearInterval(conditionHintsRefreshInterval);
        conditionHintsRefreshInterval = undefined;
      }
    }),
    vscode.workspace.registerTextDocumentContentProvider('klipper-rendered', renderPreviewProvider),
    vscode.languages.registerCompletionItemProvider(
      { language: 'klipper', scheme: '*' },
      createPrinterCompletionProvider(objectCache),
      '.',
      '[',
      '"'
    ),
    vscode.languages.registerHoverProvider(
      { language: 'klipper', scheme: '*' },
      createRealtimeHoverProvider(objectCache, () => client, output)
    ),
    vscode.workspace.onDidChangeTextDocument((event) => {
      if (event.document.languageId === 'klipper') {
        diagnostics?.update(event.document);
        conditionHints?.refresh();
      }
    }),
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (editor?.document.languageId === 'klipper') {
        diagnostics?.update(editor.document);
        conditionHints?.refresh();
      }
    }),
    vscode.window.onDidChangeVisibleTextEditors(() => {
      conditionHints?.refresh();
    }),
    vscode.window.onDidChangeTextEditorVisibleRanges((event) => {
      if (event.textEditor.document.languageId === 'klipper') {
        conditionHints?.refresh();
      }
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('klipper.diagnostics.enabled')) {
        diagnostics?.refreshAll();
      }
      if (event.affectsConfiguration('klipper.conditionHints.enabled')) {
        conditionHints?.refresh();
      }
    }),
    vscode.commands.registerCommand('klipper.setMoonrakerConnection', async () => setMoonrakerConnection(context)),
    vscode.commands.registerCommand('klipper.connectMoonraker', async () => connectMoonraker(context)),
    vscode.commands.registerCommand('klipper.refreshPrinterObjects', async () => refreshPrinterObjects()),
    vscode.commands.registerCommand('klipper.renderSelectionOrMacro', async () => renderSelectionOrMacro()),
    vscode.commands.registerCommand('klipper.peekRenderedSelectionOrMacro', async () => peekRenderedSelectionOrMacro()),
    vscode.commands.registerCommand('klipper.runSelectionOrMacro', async () => runSelectionOrMacro())
  );

  for (const document of vscode.workspace.textDocuments) {
    if (document.languageId === 'klipper') {
      diagnostics.update(document);
    }
  }
  conditionHints.refresh();
}

export async function deactivate(): Promise<void> {
  client?.dispose();
  diagnostics?.dispose();
}

async function setMoonrakerConnection(context: vscode.ExtensionContext): Promise<void> {
  const configuredUrl = vscode.workspace.getConfiguration('klipper').get<string>('moonrakerUrl')
    ?? 'ws://localhost:7125/websocket';
  const configuredHost = hostFromMoonrakerUrl(configuredUrl) ?? configuredUrl;
  const input = await vscode.window.showInputBox({
    title: 'Set Moonraker Connection',
    prompt: 'Enter your printer IP address or hostname. Full ws://, wss://, http://, or https:// URLs are also accepted.',
    placeHolder: '192.168.1.25',
    value: configuredHost,
    validateInput: (value) => {
      try {
        normalizeMoonrakerInput(value);
        return undefined;
      } catch (error) {
        return errorMessage(error);
      }
    }
  });

  if (!input) {
    return;
  }

  let url: string;
  try {
    url = normalizeMoonrakerInput(input);
  } catch (error) {
    vscode.window.showErrorMessage(`Invalid Moonraker connection: ${errorMessage(error)}`);
    return;
  }

  await vscode.workspace.getConfiguration('klipper').update(
    'moonrakerUrl',
    url,
    vscode.ConfigurationTarget.Workspace
  );

  setStatus('$(debug-disconnect) Klipper: disconnected', `Moonraker URL set to ${url}`);

  const choice = await vscode.window.showInformationMessage(
    `Moonraker connection set to ${url}.`,
    'Connect Now'
  );

  if (choice === 'Connect Now') {
    await connectMoonraker(context, false);
  }
}

async function connectMoonraker(context: vscode.ExtensionContext, promptForUrl = true): Promise<void> {
  const configuredUrl = vscode.workspace.getConfiguration('klipper').get<string>('moonrakerUrl')
    ?? 'ws://localhost:7125/websocket';
  const url = promptForUrl
    ? await vscode.window.showInputBox({
      title: 'Moonraker WebSocket URL',
      prompt: 'Enter the Moonraker WebSocket URL for your printer.',
      value: configuredUrl,
      validateInput: (value) => {
        if (!/^wss?:\/\/.+/i.test(value.trim())) {
          return 'Use a ws:// or wss:// URL.';
        }
        return undefined;
      }
    })
    : configuredUrl;

  if (!url) {
    return;
  }

  await vscode.workspace.getConfiguration('klipper').update(
    'moonrakerUrl',
    url,
    vscode.ConfigurationTarget.Workspace
  );

  client?.dispose();
  client = new MoonrakerClient(url, output);
  context.subscriptions.push(client);

  setStatus('$(sync~spin) Klipper: connecting', `Connecting to ${url}`);

  try {
    await client.connect();
    setStatus('$(plug) Klipper: connected', `Connected to ${url}`);
    output?.appendLine('Moonraker connected; refreshing printer objects and condition hints.');
    await refreshPrinterObjects();
    vscode.window.showInformationMessage('Connected to Moonraker.');
  } catch (error) {
    setStatus('$(debug-disconnect) Klipper: disconnected', `Failed to connect to ${url}`);
    conditionHints?.refresh();
    vscode.window.showErrorMessage(`Moonraker connection failed: ${errorMessage(error)}`);
  }
}

async function refreshPrinterObjects(): Promise<void> {
  if (!client?.isConnected) {
    vscode.window.showWarningMessage('Connect to Moonraker before refreshing printer objects.');
    return;
  }

  setStatus('$(sync~spin) Klipper: refreshing', 'Refreshing Moonraker printer object cache');

  try {
    const listed = await client.call<{ objects: string[] }>('printer.objects.list');
    const queryObjects = Object.fromEntries(listed.objects.map((name) => [name, null]));
    const queried = await client.call<{ status: Record<string, unknown> }>('printer.objects.query', {
      objects: queryObjects
    });
    objectCache?.replace(queried.status);
    diagnostics?.refreshAll();
    conditionHints?.refresh();
    setStatus('$(plug) Klipper: connected', `${listed.objects.length} printer objects cached`);
    output?.appendLine(`Cached ${listed.objects.length} Moonraker printer objects.`);
  } catch (error) {
    setStatus('$(warning) Klipper: refresh failed', 'Printer object refresh failed');
    vscode.window.showErrorMessage(`Could not refresh printer objects: ${errorMessage(error)}`);
  }
}

async function renderSelectionOrMacro(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.languageId !== 'klipper') {
    vscode.window.showWarningMessage('Open a Klipper configuration file before rendering.');
    return;
  }

  try {
    const source = getSelectionOrCurrentMacro(editor);
    const rendered = renderTemplate(source.text, objectCache?.status ?? {});
    const document = await vscode.workspace.openTextDocument({
      language: 'gcode',
      content: rendered
    });
    await vscode.window.showTextDocument(document, vscode.ViewColumn.Beside);
  } catch (error) {
    vscode.window.showErrorMessage(`Render failed: ${errorMessage(error)}`);
  }
}

async function peekRenderedSelectionOrMacro(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.languageId !== 'klipper') {
    vscode.window.showWarningMessage('Open a Klipper configuration file before rendering.');
    return;
  }

  try {
    const source = getSelectionOrCurrentMacro(editor);
    const rendered = renderTemplate(source.text, objectCache?.status ?? {});
    const uri = renderPreviewProvider?.createDocument(rendered, `rendered-${source.description}`);
    if (!uri) {
      throw new Error('Rendered preview provider is not initialized.');
    }

    const didPeek = await showRenderedPeek(editor, uri);
    if (!didPeek) {
      await showRenderedDocument(uri);
    }
  } catch (error) {
    vscode.window.showErrorMessage(`Peek render failed: ${errorMessage(error)}`);
  }
}

async function runSelectionOrMacro(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.languageId !== 'klipper') {
    vscode.window.showWarningMessage('Open a Klipper configuration file before running G-Code.');
    return;
  }
  if (!client?.isConnected) {
    vscode.window.showWarningMessage('Connect to Moonraker before running rendered G-Code.');
    return;
  }

  try {
    const source = getSelectionOrCurrentMacro(editor);
    const rendered = renderTemplate(source.text, objectCache?.status ?? {});
    const trimmed = rendered.trim();
    if (!trimmed) {
      vscode.window.showWarningMessage('Rendered output is empty; nothing was sent to the printer.');
      return;
    }

    const choice = await vscode.window.showWarningMessage(
      `Send rendered G-Code from ${source.description} to the printer?`,
      { modal: true },
      'Run'
    );
    if (choice !== 'Run') {
      return;
    }

    await client.call('printer.gcode.script', { script: trimmed });
    vscode.window.showInformationMessage('Rendered G-Code sent to Moonraker.');
  } catch (error) {
    vscode.window.showErrorMessage(`Run failed: ${errorMessage(error)}`);
  }
}

function setStatus(text: string, tooltip: string): void {
  if (statusBar) {
    statusBar.text = text;
    statusBar.tooltip = tooltip;
  }
}

function normalizeMoonrakerInput(input: string): string {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    throw new Error('Enter a printer IP address, hostname, or Moonraker URL.');
  }

  if (/^https?:\/\//i.test(trimmed)) {
    const httpUrl = new URL(trimmed);
    return buildMoonrakerUrl(
      httpUrl.protocol.toLowerCase() === 'https:' ? 'wss:' : 'ws:',
      httpUrl.hostname,
      (explicitPortFromUrlInput(trimmed) ?? httpUrl.port) || '7125',
      httpUrl.pathname,
      httpUrl.search
    );
  }

  if (/^wss?:\/\//i.test(trimmed)) {
    const wsUrl = new URL(trimmed);
    return buildMoonrakerUrl(
      wsUrl.protocol.toLowerCase() === 'wss:' ? 'wss:' : 'ws:',
      wsUrl.hostname,
      (explicitPortFromUrlInput(trimmed) ?? wsUrl.port) || '7125',
      wsUrl.pathname,
      wsUrl.search
    );
  }

  if (!/^[A-Za-z0-9_.:-]+$/.test(trimmed)) {
    throw new Error('Use an IP address, hostname, or Moonraker URL.');
  }

  const hostPort = parseHostPortInput(trimmed);
  return buildMoonrakerUrl('ws:', hostPort.host, hostPort.port ?? '7125', '/websocket');
}

function hostFromMoonrakerUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    return url.hostname;
  } catch {
    return undefined;
  }
}

function buildMoonrakerUrl(
  protocol: 'ws:' | 'wss:',
  hostname: string,
  port: string,
  pathname: string,
  search = ''
): string {
  const host = hostname.includes(':') && !hostname.startsWith('[')
    ? `[${hostname}]`
    : hostname;
  const normalizedPath = pathname === '/' || pathname === '' ? '/websocket' : pathname;
  return `${protocol}//${host}:${port}${normalizedPath}${search}`;
}

function explicitPortFromUrlInput(value: string): string | undefined {
  const authorityMatch = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/([^/?#]*)/.exec(value.trim());
  if (!authorityMatch) {
    return undefined;
  }

  const authority = authorityMatch[1].split('@').pop() ?? authorityMatch[1];
  if (authority.startsWith('[')) {
    return /^\[[^\]]+\]:(\d+)$/.exec(authority)?.[1];
  }

  return /:(\d+)$/.exec(authority)?.[1];
}

function parseHostPortInput(value: string): { host: string; port: string | undefined } {
  const colonCount = [...value].filter((char) => char === ':').length;
  if (colonCount === 1) {
    const match = /^(.+):(\d+)$/.exec(value);
    if (match) {
      return {
        host: match[1],
        port: match[2]
      };
    }
  }

  return {
    host: value,
    port: undefined
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
