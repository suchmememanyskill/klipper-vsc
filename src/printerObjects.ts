import * as vscode from 'vscode';
import { getResolvedCompletionReference } from './jinjaReferences';

export class PrinterObjectCache {
  private objects = new Map<string, unknown>();

  public get status(): Record<string, unknown> {
    return Object.fromEntries(this.objects.entries());
  }

  public get objectNames(): string[] {
    return [...this.objects.keys()].sort((a, b) => a.localeCompare(b));
  }

  public replace(status: Record<string, unknown>): void {
    this.objects = new Map(Object.entries(status));
  }

  public updateObject(name: string, value: unknown): void {
    this.objects.set(name, value);
  }

  public hasObject(name: string): boolean {
    return this.objects.has(name);
  }

  public getObject(name: string): unknown {
    return this.objects.get(name);
  }

  public resolvePath(path: string[]): unknown {
    if (path.length === 0) {
      return this.status;
    }

    let current = this.objects.get(path[0]);
    for (const segment of path.slice(1)) {
      current = getProperty(current, segment);
    }
    return current;
  }

  public getNestedProperties(path: string[]): string[] {
    if (path.length === 0) {
      return this.objectNames;
    }

    let current = this.objects.get(path[0]);
    for (const segment of path.slice(1)) {
      current = getProperty(current, segment);
    }

    if (Array.isArray(current)) {
      return arrayPropertyNames(current);
    }

    if (!isRecord(current)) {
      return [];
    }

    return Object.keys(current).sort((a, b) => a.localeCompare(b));
  }
}

export function createPrinterCompletionProvider(cache: PrinterObjectCache): vscode.CompletionItemProvider {
  return {
    provideCompletionItems(document, position) {
      const context = getResolvedCompletionReference(document, position);
      if (!context) {
        return undefined;
      }

      const properties = context.path.length === 0
        ? cache.objectNames
        : cache.getNestedProperties(context.path);

      const items = properties.map((name) => {
        const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Property);
        item.detail = context.path.length === 0 ? 'Moonraker printer object' : 'Moonraker printer object property';
        item.range = context.replaceRange;
        item.insertText = context.path.length === 0 ? printerObjectInsertText(name) : name;
        return item;
      });

      return new vscode.CompletionList(items, false);
    }
  };
}

export class KlipperDiagnostics implements vscode.Disposable {
  private readonly collection = vscode.languages.createDiagnosticCollection('klipper');

  public constructor(private readonly cache: PrinterObjectCache) {}

  public update(document: vscode.TextDocument): void {
    if (document.languageId !== 'klipper') {
      return;
    }

    const enabled = vscode.workspace.getConfiguration('klipper').get<boolean>('diagnostics.enabled', true);
    if (!enabled || this.cache.objectNames.length === 0) {
      this.collection.delete(document.uri);
      return;
    }

    const diagnostics: vscode.Diagnostic[] = [];
    const text = document.getText();
    for (const block of findJinjaBlocks(text)) {
      const blockText = text.slice(block.start, block.end);
      const referencePattern = /\bprinter\.([A-Za-z_][A-Za-z0-9_]*)/g;
      let match: RegExpExecArray | null;

      while ((match = referencePattern.exec(blockText)) !== null) {
        const objectName = match[1];
        if (this.cache.hasObject(objectName)) {
          continue;
        }

        const startOffset = block.start + match.index + 'printer.'.length;
        const endOffset = startOffset + objectName.length;
        const range = new vscode.Range(
          document.positionAt(startOffset),
          document.positionAt(endOffset)
        );
        diagnostics.push(new vscode.Diagnostic(
          range,
          `Moonraker did not report a printer object named "${objectName}". Use bracket syntax for names with spaces, for example printer["gcode_macro START_PRINT"].`,
          vscode.DiagnosticSeverity.Warning
        ));
      }
    }

    this.collection.set(document.uri, diagnostics);
  }

  public refreshAll(): void {
    for (const document of vscode.workspace.textDocuments) {
      if (document.languageId === 'klipper') {
        this.update(document);
      }
    }
  }

  public dispose(): void {
    this.collection.dispose();
  }
}

function printerObjectInsertText(name: string): string {
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    return name;
  }

  return `["${name.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"]`;
}

function findJinjaBlocks(text: string): Array<{ start: number; end: number }> {
  const blocks: Array<{ start: number; end: number }> = [];
  const pattern = /\{\{[\s\S]*?\}\}|\{%[\s\S]*?%\}/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    blocks.push({
      start: match.index,
      end: match.index + match[0].length
    });
  }
  return blocks;
}

function getProperty(value: unknown, property: string): unknown {
  if (Array.isArray(value)) {
    const index = arrayPropertyIndex(property);
    return index === undefined ? undefined : value[index];
  }

  if (!isRecord(value)) {
    return undefined;
  }
  return value[property];
}

function arrayPropertyNames(value: unknown[]): string[] {
  const names = value.map((_, index) => index.toString());
  const axisNames = ['x', 'y', 'z', 'e'].slice(0, value.length);
  return [...axisNames, ...names];
}

function arrayPropertyIndex(property: string): number | undefined {
  const axisIndex = ['x', 'y', 'z', 'e'].indexOf(property.toLowerCase());
  if (axisIndex >= 0) {
    return axisIndex;
  }

  if (/^\d+$/.test(property)) {
    return Number(property);
  }

  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return isRecord(value);
}
