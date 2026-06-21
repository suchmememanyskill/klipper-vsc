import * as vscode from 'vscode';
import { evaluateJinjaCondition } from './macroTools';
import { PrinterObjectCache } from './printerObjects';

type ConnectionStateProvider = () => boolean;

export class ConditionInlayHintsProvider implements vscode.InlayHintsProvider, vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<void>();

  public readonly onDidChangeInlayHints = this.changeEmitter.event;

  public constructor(
    private readonly cache: PrinterObjectCache,
    private readonly isConnected: ConnectionStateProvider
  ) {}

  public provideInlayHints(
    document: vscode.TextDocument,
    range: vscode.Range
  ): vscode.ProviderResult<vscode.InlayHint[]> {
    if (document.languageId !== 'klipper') {
      return [];
    }

    const enabled = vscode.workspace.getConfiguration('klipper').get<boolean>('conditionHints.enabled', true);
    if (!enabled || !this.isConnected()) {
      return [];
    }

    const hints: vscode.InlayHint[] = [];
    const startLine = Math.max(0, range.start.line);
    const endLine = Math.min(document.lineCount - 1, range.end.line);

    for (let lineNumber = startLine; lineNumber <= endLine; lineNumber++) {
      const line = document.lineAt(lineNumber);
      const expression = getConditionExpression(line.text);
      if (!expression) {
        continue;
      }

      let value: boolean;
      try {
        value = evaluateJinjaCondition(
          expression,
          this.cache.status,
          getSetPrelude(document, lineNumber)
        );
      } catch {
        continue;
      }

      const hint = new vscode.InlayHint(
        line.range.end,
        `-> ${value ? 'True' : 'False'}`,
        vscode.InlayHintKind.Type
      );
      hint.paddingLeft = true;
      hints.push(hint);
    }

    return hints;
  }

  public refresh(): void {
    this.changeEmitter.fire();
  }

  public dispose(): void {
    this.changeEmitter.dispose();
  }
}

function getConditionExpression(line: string): string | undefined {
  const match = /\{%-?\s*(?:if|elif)\s+([\s\S]*?)\s*-?%\}/.exec(line);
  return match?.[1].trim();
}

function getSetPrelude(document: vscode.TextDocument, beforeLine: number): string {
  const endOffset = document.offsetAt(new vscode.Position(beforeLine, 0));
  const text = document.getText().slice(0, endOffset);
  const setBlocks = text.match(/\{%\s*set\s+[A-Za-z_][A-Za-z0-9_]*\s*=\s*[\s\S]*?%\}/g);
  return setBlocks ? `${setBlocks.join('\n')}\n` : '';
}
