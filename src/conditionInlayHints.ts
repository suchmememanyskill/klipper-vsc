import * as vscode from 'vscode';
import { evaluateJinjaCondition } from './macroTools';
import { PrinterObjectCache } from './printerObjects';

type ConnectionStateProvider = () => boolean;

export class ConditionHintsController implements vscode.Disposable {
  private lastRefreshSummary = '';
  private readonly loggedEvaluationFailures = new Set<string>();

  private readonly decorationType = vscode.window.createTextEditorDecorationType({
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
    after: {
      color: new vscode.ThemeColor('editorCodeLens.foreground'),
      margin: '0 0 0 1ch'
    }
  });

  public constructor(
    private readonly cache: PrinterObjectCache,
    private readonly isConnected: ConnectionStateProvider,
    private readonly output: vscode.OutputChannel | undefined
  ) {
    this.output?.appendLine('Condition hints controller initialized.');
  }

  public refresh(): void {
    const visibleEditors = vscode.window.visibleTextEditors;
    const summaries: RefreshSummary[] = [];

    if (visibleEditors.length === 0) {
      this.logRefreshSummary([{
        editor: 'none',
        languageId: 'none',
        connected: this.isConnected(),
        enabled: vscode.workspace.getConfiguration('klipper').get<boolean>('conditionHints.enabled', true),
        objectCount: this.cache.objectNames.length,
        visibleLineCount: 0,
        candidateCount: 0,
        hintCount: 0,
        skippedCount: 0
      }]);
      return;
    }

    for (const editor of vscode.window.visibleTextEditors) {
      if (editor.document.languageId === 'klipper') {
        summaries.push(this.updateEditor(editor));
      } else {
        editor.setDecorations(this.decorationType, []);
        summaries.push({
          editor: editor.document.uri.toString(true),
          languageId: editor.document.languageId,
          connected: this.isConnected(),
          enabled: vscode.workspace.getConfiguration('klipper').get<boolean>('conditionHints.enabled', true),
          objectCount: this.cache.objectNames.length,
          visibleLineCount: 0,
          candidateCount: 0,
          hintCount: 0,
          skippedCount: 0
        });
      }
    }

    this.logRefreshSummary(summaries);
  }

  public dispose(): void {
    this.decorationType.dispose();
  }

  private updateEditor(editor: vscode.TextEditor): RefreshSummary {
    const enabled = vscode.workspace.getConfiguration('klipper').get<boolean>('conditionHints.enabled', true);
    const summary: RefreshSummary = {
      editor: editor.document.uri.toString(true),
      languageId: editor.document.languageId,
      connected: this.isConnected(),
      enabled,
      objectCount: this.cache.objectNames.length,
      visibleLineCount: 0,
      candidateCount: 0,
      hintCount: 0,
      skippedCount: 0
    };

    if (!enabled || !this.isConnected()) {
      editor.setDecorations(this.decorationType, []);
      return summary;
    }

    const lineNumbers = visibleLineNumbers(editor);
    summary.visibleLineCount = lineNumbers.length;
    if (lineNumbers.length === 0) {
      editor.setDecorations(this.decorationType, []);
      return summary;
    }

    const hints: vscode.DecorationOptions[] = [];
    for (const lineNumber of lineNumbers) {
      const line = editor.document.lineAt(lineNumber);
      const condition = getConditionExpression(line.text);
      if (!condition) {
        continue;
      }
      summary.candidateCount++;

      let value: boolean;
      try {
        value = evaluateJinjaCondition(
          condition.expression,
          this.cache.status,
          getSetPrelude(editor.document, lineNumber)
        );
      } catch (error) {
        summary.skippedCount++;
        this.logEvaluationFailure(editor, lineNumber, condition.expression, error);
        continue;
      }

      hints.push({
        range: new vscode.Range(
          new vscode.Position(lineNumber, condition.endCharacter),
          new vscode.Position(lineNumber, condition.endCharacter)
        ),
        renderOptions: {
          after: {
            contentText: ` -> ${value ? 'True' : 'False'}`
          }
        }
      });
    }

    editor.setDecorations(this.decorationType, hints);
    summary.hintCount = hints.length;
    return summary;
  }

  private logRefreshSummary(summaries: RefreshSummary[]): void {
    const text = summaries
      .map((summary) => {
        return [
          `editor=${summary.editor}`,
          `language=${summary.languageId}`,
          `connected=${summary.connected}`,
          `enabled=${summary.enabled}`,
          `objects=${summary.objectCount}`,
          `visibleLines=${summary.visibleLineCount}`,
          `conditions=${summary.candidateCount}`,
          `hints=${summary.hintCount}`,
          `skipped=${summary.skippedCount}`
        ].join(' ');
      })
      .join(' | ');

    if (text === this.lastRefreshSummary) {
      return;
    }

    this.lastRefreshSummary = text;
    this.output?.appendLine(`Condition hints refresh: ${text}`);
  }

  private logEvaluationFailure(
    editor: vscode.TextEditor,
    lineNumber: number,
    expression: string,
    error: unknown
  ): void {
    const message = error instanceof Error ? error.message : String(error);
    const key = `${editor.document.uri.toString(true)}:${lineNumber}:${expression}:${message}`;
    if (this.loggedEvaluationFailures.has(key)) {
      return;
    }

    this.loggedEvaluationFailures.add(key);
    this.output?.appendLine(
      `Condition hint skipped at ${editor.document.uri.toString(true)}:${lineNumber + 1}: "${expression}" (${message})`
    );
  }
}

interface RefreshSummary {
  editor: string;
  languageId: string;
  connected: boolean;
  enabled: boolean | undefined;
  objectCount: number;
  visibleLineCount: number;
  candidateCount: number;
  hintCount: number;
  skippedCount: number;
}

function visibleLineNumbers(editor: vscode.TextEditor): number[] {
  const lines = new Set<number>();
  for (const range of editor.visibleRanges) {
    const startLine = Math.max(0, range.start.line);
    const endLine = Math.min(editor.document.lineCount - 1, range.end.line);
    for (let line = startLine; line <= endLine; line++) {
      lines.add(line);
    }
  }

  if (lines.size === 0) {
    for (let line = 0; line < editor.document.lineCount; line++) {
      lines.add(line);
    }
  }

  return [...lines].sort((a, b) => a - b);
}

function getConditionExpression(line: string): { expression: string; endCharacter: number } | undefined {
  const match = /\{%-?\s*(?:if|elif)\s+([\s\S]*?)\s*-?%\}/.exec(line);
  if (!match) {
    return undefined;
  }

  return {
    expression: match[1].trim(),
    endCharacter: match.index + match[0].length
  };
}

function getSetPrelude(document: vscode.TextDocument, beforeLine: number): string {
  const endOffset = document.offsetAt(new vscode.Position(beforeLine, 0));
  const text = document.getText().slice(0, endOffset);
  const setBlocks = text.match(/\{%\s*set\s+[A-Za-z_][A-Za-z0-9_]*\s*=\s*[\s\S]*?%\}/g);
  return setBlocks ? `${setBlocks.join('\n')}\n` : '';
}
