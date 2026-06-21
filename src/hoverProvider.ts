import * as vscode from 'vscode';
import { MoonrakerClient } from './moonrakerClient';
import { isObjectRecord, PrinterObjectCache } from './printerObjects';
import { getResolvedReferenceAtPosition } from './jinjaReferences';
import { evaluateJinjaExpressionValue } from './macroTools';

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

      if (reference.valueExpression !== undefined) {
        let source = 'cached';
        const client = getClient();
        if (client?.isConnected) {
          source = await refreshExpressionPrinterObjects(
            client,
            cache,
            `${reference.prelude ?? ''}\n${reference.valueExpression}`,
            output
          ) ? 'live' : 'cached';
        }

        try {
          const value = evaluateJinjaExpressionValue(
            reference.valueExpression,
            cache.status,
            reference.prelude
          );
          return createValueHover(reference, value, source);
        } catch (error) {
          output?.appendLine(`Realtime hover expression failed for ${reference.expression}: ${errorMessage(error)}`);
          return new vscode.Hover(
            new vscode.MarkdownString(`\`${reference.expression}\`\n\nValue is not available from Moonraker.`),
            reference.range
          );
        }
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

async function refreshExpressionPrinterObjects(
  client: MoonrakerClient,
  cache: PrinterObjectCache,
  expression: string,
  output: vscode.OutputChannel | undefined
): Promise<boolean> {
  const rootObjects = findPrinterRootReferences(expression);
  if (rootObjects.length === 0) {
    return false;
  }

  try {
    const response = await client.call<{ status: Record<string, unknown> }>('printer.objects.query', {
      objects: Object.fromEntries(rootObjects.map((rootObject) => [rootObject, null]))
    });

    for (const rootObject of rootObjects) {
      if (Object.prototype.hasOwnProperty.call(response.status, rootObject)) {
        cache.updateObject(rootObject, response.status[rootObject]);
      }
    }
    return true;
  } catch (error) {
    output?.appendLine(`Realtime hover expression query failed: ${errorMessage(error)}`);
    return false;
  }
}

function findPrinterRootReferences(expression: string): string[] {
  const roots = new Set<string>();
  const pattern = /\bprinter(?:\.([A-Za-z_][A-Za-z0-9_]*)|\["((?:\\"|[^"])+?)"\]|\['((?:\\'|[^'])+?)'\])/g;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(expression)) !== null) {
    const root = match[1] ?? unescapeBracketString(match[2] ?? match[3] ?? '');
    if (root.length > 0) {
      roots.add(root);
    }
  }

  return [...roots];
}

function unescapeBracketString(value: string): string {
  return value.replace(/\\(["'\\])/g, '$1');
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
