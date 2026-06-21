import * as vscode from 'vscode';

export interface ResolvedReference {
  expression: string;
  range: vscode.Range;
  path?: string[];
  value?: unknown;
  sourceExpression?: string;
}

export interface CompletionReference {
  path: string[];
  replaceRange: vscode.Range;
}

const propertySegment = String.raw`(?:\.[A-Za-z_][A-Za-z0-9_]*|\["(?:\\"|[^"])+?"\]|\['(?:\\'|[^'])+?'\])`;
const referencePattern = new RegExp(String.raw`\b(?:printer|[A-Za-z_][A-Za-z0-9_]*)${propertySegment}+`, 'g');

export function getResolvedReferenceAtPosition(
  document: vscode.TextDocument,
  position: vscode.Position
): ResolvedReference | undefined {
  const line = document.lineAt(position.line).text;
  const aliases = collectAliases(document, document.offsetAt(position));
  const references = findReferences(line, position.line, aliases);
  const propertyReference = references.find((reference) => reference.range.contains(position));
  if (propertyReference) {
    return propertyReference;
  }

  const wordRange = document.getWordRangeAtPosition(position, /[A-Za-z_][A-Za-z0-9_]*/);
  if (!wordRange) {
    return undefined;
  }

  const word = document.getText(wordRange);
  const alias = aliases.get(word);
  if (!alias) {
    return undefined;
  }

  if (alias.kind === 'value') {
    return {
      expression: word,
      value: alias.value,
      range: wordRange,
      sourceExpression: alias.sourceExpression
    };
  }

  return {
    expression: word,
    path: alias.path,
    range: wordRange,
    sourceExpression: formatPrinterPath(alias.path)
  };
}

export function getResolvedCompletionReference(
  document: vscode.TextDocument,
  position: vscode.Position
): CompletionReference | undefined {
  const linePrefix = document.lineAt(position).text.slice(0, position.character);
  const match = /\b(?:printer|[A-Za-z_][A-Za-z0-9_]*)(?:(?:\.[A-Za-z_][A-Za-z0-9_]*)|(?:\["(?:\\"|[^"])+?"\])|(?:\['(?:\\'|[^'])+?'\]))*\.?(?:[A-Za-z_][A-Za-z0-9_]*)?$/.exec(linePrefix);
  if (!match) {
    return undefined;
  }

  const aliases = collectAliases(document, document.offsetAt(position));
  const expression = match[0];
  const endsWithDot = expression.endsWith('.');
  const partialMatch = endsWithDot ? undefined : /[A-Za-z_][A-Za-z0-9_]*$/.exec(expression);
  const partial = partialMatch?.[0] ?? '';
  const expressionWithoutPartial = partial.length > 0 ? expression.slice(0, -partial.length) : expression;
  const parentExpression = expressionWithoutPartial.endsWith('.')
    ? expressionWithoutPartial.slice(0, -1)
    : expressionWithoutPartial;
  const path = resolveReferenceExpression(parentExpression, aliases);

  if (!path) {
    return undefined;
  }

  const replaceStart = new vscode.Position(position.line, position.character - partial.length);
  return {
    path,
    replaceRange: new vscode.Range(replaceStart, position)
  };
}

function findReferences(
  line: string,
  lineNumber: number,
  aliases: Map<string, AliasValue>
): ResolvedReference[] {
  const references: ResolvedReference[] = [];
  let match: RegExpExecArray | null;

  while ((match = referencePattern.exec(line)) !== null) {
    const expression = match[0];
    const path = resolveReferenceExpression(expression, aliases);
    if (!path) {
      continue;
    }

    references.push({
      expression,
      path,
      range: new vscode.Range(
        new vscode.Position(lineNumber, match.index),
        new vscode.Position(lineNumber, match.index + expression.length)
      ),
      sourceExpression: expression.startsWith('printer') ? undefined : formatPrinterPath(path)
    });
  }

  return references;
}

type AliasValue =
  | { kind: 'path'; path: string[] }
  | { kind: 'value'; value: unknown; sourceExpression?: string };

function collectAliases(document: vscode.TextDocument, beforeOffset: number): Map<string, AliasValue> {
  const aliases = new Map<string, AliasValue>();
  const text = document.getText();
  const setPattern = /\{%\s*set\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*([\s\S]*?)%\}/g;
  let match: RegExpExecArray | null;

  while ((match = setPattern.exec(text)) !== null) {
    const assignmentStart = match.index;
    const assignmentEnd = match.index + match[0].length;
    const isBeforeCursor = assignmentEnd <= beforeOffset;
    const containsCursor = assignmentStart <= beforeOffset && beforeOffset <= assignmentEnd;
    if (!isBeforeCursor && !containsCursor) {
      continue;
    }

    const variableName = match[1];
    const rawExpression = match[2].trim();
    const expression = stripFilters(rawExpression);
    const path = resolveReferenceExpression(expression, aliases);
    if (path) {
      aliases.set(variableName, { kind: 'path', path });
      continue;
    }

    const defaultReferencePath = resolveDefaultReferencePath(rawExpression, aliases);
    if (defaultReferencePath) {
      aliases.set(variableName, { kind: 'path', path: defaultReferencePath });
      continue;
    }

    const literalDefault = parseDefaultFilterValue(rawExpression);
    if (literalDefault.resolved) {
      aliases.set(variableName, {
        kind: 'value',
        value: literalDefault.value,
        sourceExpression: `${expression}|default(...)`
      });
    }
  }

  return aliases;
}

function resolveDefaultReferencePath(
  expression: string,
  aliases: Map<string, AliasValue>
): string[] | undefined {
  const fallbackExpression = parseDefaultFilterExpression(expression);
  if (!fallbackExpression) {
    return undefined;
  }

  return resolveReferenceExpression(stripFilters(fallbackExpression), aliases);
}

function resolveReferenceExpression(
  expression: string,
  aliases: Map<string, AliasValue>
): string[] | undefined {
  const rootMatch = /^[A-Za-z_][A-Za-z0-9_]*/.exec(expression);
  if (!rootMatch) {
    return undefined;
  }

  const root = rootMatch[0];
  const alias = root === 'printer' ? { kind: 'path' as const, path: [] } : aliases.get(root);
  if (!alias || alias.kind !== 'path') {
    return undefined;
  }

  const suffix = expression.slice(root.length);
  const parsedSuffix = parsePathSuffix(suffix);
  if (!parsedSuffix) {
    return undefined;
  }

  return [...alias.path, ...parsedSuffix];
}

function parsePathSuffix(suffix: string): string[] | undefined {
  const path: string[] = [];
  let index = 0;

  while (index < suffix.length) {
    if (suffix[index] === '.') {
      const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(suffix.slice(index + 1));
      if (!match) {
        return undefined;
      }
      path.push(match[0]);
      index += match[0].length + 1;
      continue;
    }

    if (suffix[index] === '[') {
      const parsed = parseBracketSegment(suffix, index);
      if (!parsed) {
        return undefined;
      }
      path.push(parsed.value);
      index = parsed.nextIndex;
      continue;
    }

    return undefined;
  }

  return path;
}

function parseBracketSegment(
  expression: string,
  startIndex: number
): { value: string; nextIndex: number } | undefined {
  const quote = expression[startIndex + 1];
  if (quote !== '"' && quote !== "'") {
    return undefined;
  }

  let value = '';
  let index = startIndex + 2;
  while (index < expression.length) {
    const char = expression[index];
    if (char === '\\') {
      value += expression[index + 1] ?? '';
      index += 2;
      continue;
    }
    if (char === quote && expression[index + 1] === ']') {
      return {
        value,
        nextIndex: index + 2
      };
    }
    value += char;
    index++;
  }

  return undefined;
}

function stripFilters(expression: string): string {
  let quote: '"' | "'" | undefined;
  let bracketDepth = 0;
  let parenDepth = 0;

  for (let index = 0; index < expression.length; index++) {
    const char = expression[index];
    if (quote) {
      if (char === '\\') {
        index++;
        continue;
      }
      if (char === quote) {
        quote = undefined;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === '[') {
      bracketDepth++;
      continue;
    }
    if (char === ']') {
      bracketDepth = Math.max(0, bracketDepth - 1);
      continue;
    }
    if (char === '(') {
      parenDepth++;
      continue;
    }
    if (char === ')') {
      parenDepth = Math.max(0, parenDepth - 1);
      continue;
    }
    if (char === '|' && bracketDepth === 0 && parenDepth === 0) {
      return expression.slice(0, index).trim();
    }
  }

  return expression.trim();
}

function parseDefaultFilterValue(expression: string): { resolved: boolean; value: unknown } {
  const fallbackExpression = parseDefaultFilterExpression(expression);
  if (!fallbackExpression) {
    return {
      resolved: false,
      value: undefined
    };
  }

  const raw = fallbackExpression.trim();
  if ((raw.startsWith("'") && raw.endsWith("'")) || (raw.startsWith('"') && raw.endsWith('"'))) {
    return {
      resolved: true,
      value: raw.slice(1, -1)
    };
  }
  if (/^-?\d+(?:\.\d+)?$/.test(raw)) {
    return {
      resolved: true,
      value: Number(raw)
    };
  }
  if (raw === '{}') {
    return {
      resolved: true,
      value: {}
    };
  }
  if (raw === '[]') {
    return {
      resolved: true,
      value: []
    };
  }
  if (raw === 'true' || raw === 'false') {
    return {
      resolved: true,
      value: raw === 'true'
    };
  }
  if (raw === 'none') {
    return {
      resolved: true,
      value: null
    };
  }

  return {
    resolved: false,
    value: undefined
  };
}

function parseDefaultFilterExpression(expression: string): string | undefined {
  const match = /\|\s*default\s*\(/.exec(expression);
  if (!match) {
    return undefined;
  }

  const startIndex = match.index + match[0].length;
  let quote: '"' | "'" | undefined;
  let parenDepth = 1;

  for (let index = startIndex; index < expression.length; index++) {
    const char = expression[index];
    if (quote) {
      if (char === '\\') {
        index++;
        continue;
      }
      if (char === quote) {
        quote = undefined;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === '(') {
      parenDepth++;
      continue;
    }
    if (char === ')') {
      parenDepth--;
      if (parenDepth === 0) {
        return expression.slice(startIndex, index).trim();
      }
    }
  }

  return undefined;
}

function formatPrinterPath(path: string[]): string {
  return `printer${path.map((segment) => {
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(segment)) {
      return `.${segment}`;
    }
    return `["${segment.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"]`;
  }).join('')}`;
}
