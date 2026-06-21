import * as vscode from 'vscode';

const scheme = 'klipper-rendered';

export class RenderPreviewProvider implements vscode.TextDocumentContentProvider, vscode.Disposable {
  private readonly documents = new Map<string, string>();
  private readonly changeEmitter = new vscode.EventEmitter<vscode.Uri>();

  public readonly onDidChange = this.changeEmitter.event;

  public provideTextDocumentContent(uri: vscode.Uri): string {
    return this.documents.get(uri.toString()) ?? '';
  }

  public createDocument(content: string, label: string): vscode.Uri {
    const uri = vscode.Uri.from({
      scheme,
      path: `/${sanitizePath(label)}.gcode`,
      query: Date.now().toString()
    });

    this.documents.set(uri.toString(), content);
    this.changeEmitter.fire(uri);
    return uri;
  }

  public dispose(): void {
    this.changeEmitter.dispose();
    this.documents.clear();
  }
}

export async function showRenderedPeek(
  sourceEditor: vscode.TextEditor,
  renderedUri: vscode.Uri
): Promise<boolean> {
  const location = new vscode.Location(
    renderedUri,
    new vscode.Range(new vscode.Position(0, 0), new vscode.Position(0, 0))
  );

  try {
    await vscode.commands.executeCommand(
      'editor.action.peekLocations',
      sourceEditor.document.uri,
      sourceEditor.selection.active,
      [location],
      'peek'
    );
    return true;
  } catch {
    return false;
  }
}

export async function showRenderedDocument(renderedUri: vscode.Uri): Promise<void> {
  const document = await vscode.workspace.openTextDocument(renderedUri);
  await vscode.window.showTextDocument(document, vscode.ViewColumn.Beside, true);
}

function sanitizePath(value: string): string {
  const sanitized = value
    .replace(/[^A-Za-z0-9_.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);

  return sanitized.length > 0 ? sanitized : 'rendered-macro';
}
