import * as vscode from 'vscode';
import { MoonrakerClient } from './moonrakerClient';
import { isObjectRecord, PrinterObjectCache } from './printerObjects';
import { getResolvedReferenceAtPosition } from './jinjaReferences';

type ClientAccessor = () => MoonrakerClient | undefined;

export function createRealtimeHoverProvider(
  cache: PrinterObjectCache,
  getClient: ClientAccessor,
  output: vscode.OutputChannel | undefined
): vscode.HoverProvider {
  return {
    async provideHover(document, position, token) {
      const reference = getResolvedReferenceAtPosition(document, position);
      if (!reference) {
        return undefined;
      }

      if (reference.path === undefined) {
        return createValueHover(reference, reference.value, 'local');
      }

      let value = cache.resolvePath(reference.path);
      let source = 'cached';
      const client = getClient();

      if (client?.isConnected && reference.path.length > 0) {
        try {
          const rootObject = reference.path[0];
          const response = await client.call<{ status: Record<string, unknown> }>('printer.objects.query', {
            objects: {
              [rootObject]: null
            }
          });

          if (token.isCancellationRequested) {
            return undefined;
          }

          if (Object.prototype.hasOwnProperty.call(response.status, rootObject)) {
            cache.updateObject(rootObject, response.status[rootObject]);
            value = cache.resolvePath(reference.path);
            source = 'live';
          }
        } catch (error) {
          output?.appendLine(`Realtime hover query failed for ${reference.expression}: ${errorMessage(error)}`);
        }
      }

      if (value === undefined) {
        return new vscode.Hover(
          new vscode.MarkdownString(`\`${reference.expression}\`\n\nValue is not available from Moonraker.`),
          reference.range
        );
      }

      return createValueHover(reference, value, source);
    }
  };
}

function createValueHover(
  reference: { expression: string; range: vscode.Range; sourceExpression?: string },
  value: unknown,
  source: string
): vscode.Hover {
  const markdown = new vscode.MarkdownString(undefined, true);
  markdown.isTrusted = false;
  markdown.appendMarkdown(`\`${reference.expression}\` (${source})\n\n`);
  if (reference.sourceExpression) {
    markdown.appendMarkdown(`Resolved from \`${reference.sourceExpression}\`\n\n`);
  }
  markdown.appendCodeblock(formatHoverValue(value), 'json');

  return new vscode.Hover(markdown, reference.range);
}

function formatHoverValue(value: unknown): string {
  if (isObjectRecord(value) || Array.isArray(value)) {
    return JSON.stringify(value, null, 2);
  }

  return JSON.stringify(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
