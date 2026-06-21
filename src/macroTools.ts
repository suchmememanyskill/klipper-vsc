import * as vscode from 'vscode';
import nunjucks from 'nunjucks';

export interface MacroSource {
  text: string;
  description: string;
}

const renderEnv = new nunjucks.Environment(undefined, {
  autoescape: false,
  throwOnUndefined: false,
  trimBlocks: false,
  lstripBlocks: false
});

installKlipperCompatibleFilters(renderEnv);

const conditionEnv = new nunjucks.Environment(undefined, {
  autoescape: false,
  throwOnUndefined: false,
  trimBlocks: false,
  lstripBlocks: false
});

installKlipperCompatibleFilters(conditionEnv);

export function getSelectionOrCurrentMacro(editor: vscode.TextEditor): MacroSource {
  const selection = editor.selection;
  if (!selection.isEmpty) {
    return {
      text: editor.document.getText(selection),
      description: 'selection'
    };
  }

  const macro = getCurrentGcodeMacro(editor.document, selection.active);
  if (macro) {
    return macro;
  }

  return {
    text: editor.document.getText(),
    description: 'document'
  };
}

export function renderTemplate(template: string, printerStatus: Record<string, unknown>): string {
  return removeBlankLines(renderEnv.renderString(normalizeKlipperVariableTags(template), createRenderContext(printerStatus)));
}

export function evaluateJinjaCondition(
  expression: string,
  printerStatus: Record<string, unknown>,
  prelude = ''
): boolean {
  const context = createRenderContext(printerStatus);
  const conditionContext = createConditionContext(expression, prelude, context, true);
  if (!conditionContext) {
    throw new Error(`Condition contains unresolved references: ${expression}`);
  }

  const rendered = conditionEnv.renderString(
    `{% if ${expression} %}true{% else %}false{% endif %}`,
    conditionContext
  ).trim().toLowerCase();

  if (rendered === 'true') {
    return true;
  }
  if (rendered === 'false') {
    return false;
  }

  throw new Error(`Condition did not render to a boolean: ${rendered}`);
}

export function evaluateJinjaExpressionValue(
  expression: string,
  printerStatus: Record<string, unknown>,
  prelude = ''
): unknown {
  const context = createRenderContext(printerStatus);
  const expressionContext = createConditionContext(expression, prelude, context, true);
  if (!expressionContext) {
    throw new Error(`Expression contains unresolved references: ${expression}`);
  }

  const rendered = conditionEnv.renderString(
    `{{ (${expression}) | __klipperJson }}`,
    expressionContext
  ).trim();
  const parsed = JSON.parse(rendered) as { value?: unknown };
  if (!Object.prototype.hasOwnProperty.call(parsed, 'value')) {
    throw new Error(`Expression did not render to a value: ${expression}`);
  }

  return parsed.value;
}

function createRenderContext(printerStatus: Record<string, unknown>): Record<string, unknown> {
  return {
    printer: withKlipperArrayAliases(printerStatus),
    params: {},
    rawparams: '',
    action_respond_info: (message: unknown) => `RESPOND MSG="${String(message)}"`,
    action_raise_error: (message: unknown) => {
      throw new Error(String(message));
    },
    action_emergency_stop: (message?: unknown) => {
      throw new Error(`Emergency stop requested while rendering: ${String(message ?? '')}`);
    },
    action_call_remote_method: () => ''
  };
}

function getCurrentGcodeMacro(document: vscode.TextDocument, position: vscode.Position): MacroSource | undefined {
  const sectionStart = findSectionStart(document, position.line);
  if (sectionStart === undefined) {
    return undefined;
  }

  const header = document.lineAt(sectionStart).text.trim();
  const match = /^\[gcode_macro\s+([^\]]+)\]$/i.exec(header);
  if (!match) {
    return undefined;
  }

  const sectionEnd = findSectionEnd(document, sectionStart + 1);
  const lines: string[] = [];
  let inGcode = false;
  let baseIndent: number | undefined;

  for (let lineNumber = sectionStart + 1; lineNumber < sectionEnd; lineNumber++) {
    const line = document.lineAt(lineNumber).text;

    if (!inGcode) {
      if (/^\s*gcode\s*:\s*$/i.test(line)) {
        inGcode = true;
      }
      continue;
    }

    if (/^\s*[A-Za-z_][A-Za-z0-9_\-]*\s*:/.test(line) && line.trim().length > 0) {
      break;
    }

    if (line.trim().length > 0 && baseIndent === undefined) {
      baseIndent = leadingWhitespace(line);
    }

    lines.push(baseIndent === undefined ? line : line.slice(Math.min(baseIndent, leadingWhitespace(line))));
  }

  if (!inGcode || lines.length === 0) {
    return undefined;
  }

  return {
    text: lines.join('\n'),
    description: `macro ${match[1]}`
  };
}

function findSectionStart(document: vscode.TextDocument, fromLine: number): number | undefined {
  for (let line = fromLine; line >= 0; line--) {
    if (/^\s*\[[^\]]+\]\s*$/.test(document.lineAt(line).text)) {
      return line;
    }
  }
  return undefined;
}

function findSectionEnd(document: vscode.TextDocument, fromLine: number): number {
  for (let line = fromLine; line < document.lineCount; line++) {
    if (/^\s*\[[^\]]+\]\s*$/.test(document.lineAt(line).text)) {
      return line;
    }
  }
  return document.lineCount;
}

function leadingWhitespace(value: string): number {
  const match = /^(\s*)/.exec(value);
  return match?.[1].length ?? 0;
}

function removeBlankLines(value: string): string {
  return value
    .split(/\r?\n/)
    .map((line) => stripRenderedLineComment(line))
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join('\n');
}

function normalizeKlipperVariableTags(template: string): string {
  let output = '';
  let index = 0;

  while (index < template.length) {
    if (template.startsWith('{%', index)) {
      const end = template.indexOf('%}', index + 2);
      if (end === -1) {
        output += template.slice(index);
        break;
      }
      output += template.slice(index, end + 2);
      index = end + 2;
      continue;
    }

    if (template.startsWith('{#', index)) {
      const end = template.indexOf('#}', index + 2);
      if (end === -1) {
        output += template.slice(index);
        break;
      }
      output += template.slice(index, end + 2);
      index = end + 2;
      continue;
    }

    if (template.startsWith('{{', index)) {
      output += '{{';
      index += 2;
      continue;
    }

    if (template[index] === '{') {
      const end = findKlipperVariableTagEnd(template, index + 1);
      if (end === -1) {
        output += template[index];
        index++;
        continue;
      }

      output += `{{ ${template.slice(index + 1, end).trim()} }}`;
      index = end + 1;
      continue;
    }

    output += template[index];
    index++;
  }

  return output;
}

function findKlipperVariableTagEnd(template: string, startIndex: number): number {
  let quote: '"' | "'" | undefined;

  for (let index = startIndex; index < template.length; index++) {
    const char = template[index];
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

    if (char === '}') {
      return index;
    }
  }

  return -1;
}

function stripRenderedLineComment(line: string): string {
  const commentIndex = findRenderedCommentStart(line);
  return commentIndex === undefined ? line : line.slice(0, commentIndex);
}

function findRenderedCommentStart(line: string): number | undefined {
  let quote: '"' | "'" | undefined;
  for (let index = 0; index < line.length; index++) {
    const char = line[index];
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
    if (char === ';' || char === '#') {
      return index;
    }
  }

  return undefined;
}

function installKlipperCompatibleFilters(environment: nunjucks.Environment): void {
  environment.addFilter('string', (value: unknown) => stringifyFilterValue(value));
  environment.addFilter('lower', (value: unknown) => stringifyFilterValue(value).toLowerCase());
  environment.addFilter('upper', (value: unknown) => stringifyFilterValue(value).toUpperCase());
  environment.addFilter('capitalize', (value: unknown) => {
    const text = stringifyFilterValue(value).toLowerCase();
    return text.length === 0 ? text : `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
  });
  environment.addFilter('title', (value: unknown) => {
    return stringifyFilterValue(value).replace(/\S+/g, (word) => {
      const lowered = word.toLowerCase();
      return `${lowered.charAt(0).toUpperCase()}${lowered.slice(1)}`;
    });
  });
  environment.addFilter('trim', (value: unknown) => stringifyFilterValue(value).trim());
  environment.addFilter('__klipperJson', (value: unknown) => JSON.stringify({ value }));
}

function stringifyFilterValue(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  if (typeof value === 'string') {
    return value;
  }
  return String(value);
}

interface KnownValue {
  value: unknown;
  path?: string[];
}

interface ResolvedValue {
  resolved: boolean;
  value: unknown;
  path?: string[];
}

function createConditionContext(
  expression: string,
  prelude: string,
  context: Record<string, unknown>,
  allowPrinterReferences: boolean
): Record<string, unknown> | undefined {
  const known = new Map<string, KnownValue>([
    ['params', { value: context.params }],
    ['rawparams', { value: context.rawparams }]
  ]);
  if (allowPrinterReferences) {
    known.set('printer', { value: context.printer, path: [] });
  }

  const setPattern = /\{%\s*set\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*([\s\S]*?)%\}/g;
  let match: RegExpExecArray | null;
  while ((match = setPattern.exec(prelude)) !== null) {
    const value = resolveExpressionValue(match[2].trim(), known);
    if (value.resolved) {
      known.set(match[1], { value: value.value, path: value.path });
    }
  }

  if (!expressionReferencesResolve(expression, known)) {
    return undefined;
  }

  return {
    ...context,
    ...Object.fromEntries([...known.entries()].map(([name, knownValue]) => [name, knownValue.value]))
  };
}

function expressionReferencesResolve(expression: string, known: Map<string, KnownValue>): boolean {
  for (const reference of findExpressionReferences(expression)) {
    if (referenceHasDefaultFilter(expression, reference.end)) {
      continue;
    }

    const value = resolveReferenceValue(reference.expression, known);
    if (!value.resolved || value.value === undefined) {
      return false;
    }
  }

  return true;
}

function resolveExpressionValue(
  expression: string,
  known: Map<string, KnownValue>
): ResolvedValue {
  const evaluated = evaluateKnownExpressionValue(expression, known);
  if (evaluated.resolved) {
    return evaluated;
  }

  const baseExpression = stripTopLevelFilters(expression);
  const reference = findExpressionReferences(baseExpression)[0];

  if (!reference || reference.expression !== baseExpression.trim()) {
    return resolveDefaultFilterValue(expression, known);
  }

  const value = resolveReferenceValue(reference.expression, known);
  if (value.resolved && value.value !== undefined) {
    return value;
  }

  return resolveDefaultFilterValue(expression, known);
}

function evaluateKnownExpressionValue(
  expression: string,
  known: Map<string, KnownValue>
): ResolvedValue {
  if (!expressionReferencesResolve(expression, known)) {
    return {
      resolved: false,
      value: undefined
    };
  }

  try {
    const rendered = conditionEnv.renderString(
      `{{ (${expression}) | __klipperJson }}`,
      knownValuesToContext(known)
    ).trim();
    const parsed = JSON.parse(rendered) as { value?: unknown };
    if (!Object.prototype.hasOwnProperty.call(parsed, 'value')) {
      return {
        resolved: false,
        value: undefined
      };
    }

    return {
      resolved: true,
      value: parsed.value
    };
  } catch {
    return {
      resolved: false,
      value: undefined
    };
  }
}

function knownValuesToContext(known: Map<string, KnownValue>): Record<string, unknown> {
  return Object.fromEntries([...known.entries()].map(([name, knownValue]) => [name, knownValue.value]));
}

function resolveReferenceValue(
  expression: string,
  known: Map<string, KnownValue>
): ResolvedValue {
  const rootMatch = /^[A-Za-z_][A-Za-z0-9_]*/.exec(expression);
  if (!rootMatch) {
    return {
      resolved: false,
      value: undefined
    };
  }

  const root = rootMatch[0];
  if (!known.has(root)) {
    return {
      resolved: false,
      value: undefined
    };
  }

  const suffix = expression.slice(root.length);
  const suffixPath = parsePathSuffix(suffix);
  if (!suffixPath) {
    return {
      resolved: false,
      value: undefined
    };
  }

  const rootValue = known.get(root);
  let current = rootValue?.value;
  for (const segment of suffixPath) {
    current = getPathValue(current, segment);
  }

  return {
    resolved: true,
    value: current,
    path: rootValue?.path ? [...rootValue.path, ...suffixPath] : undefined
  };
}

function findExpressionReferences(expression: string): Array<{ expression: string; end: number }> {
  const withoutStrings = maskQuotedStrings(expression);
  const pattern = /\b[A-Za-z_][A-Za-z0-9_]*(?:(?:\.[A-Za-z_][A-Za-z0-9_]*)|(?:\["(?:\\"|[^"])+?"\])|(?:\['(?:\\'|[^'])+?'\]))*/g;
  const references: Array<{ expression: string; end: number }> = [];
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(withoutStrings)) !== null) {
    const word = match[0];
    const previous = previousNonWhitespace(withoutStrings, match.index);
    if (
      previous === '|' ||
      previous === '.' ||
      ['and', 'or', 'not', 'in', 'is', 'if', 'else', 'true', 'false', 'none'].includes(word)
    ) {
      continue;
    }

    references.push({
      expression: expression.slice(match.index, match.index + word.length),
      end: match.index + word.length
    });
  }

  return references;
}

function referenceHasDefaultFilter(expression: string, referenceEnd: number): boolean {
  return /^\s*\|\s*default\s*\(/.test(expression.slice(referenceEnd));
}

function resolveDefaultFilterValue(
  expression: string,
  known: Map<string, KnownValue>
): ResolvedValue {
  const literal = parseDefaultFilterValue(expression);
  if (literal.resolved) {
    return literal;
  }

  const fallbackExpression = parseDefaultFilterExpression(expression);
  if (!fallbackExpression) {
    return {
      resolved: false,
      value: undefined
    };
  }

  return resolveExpressionValue(fallbackExpression, known);
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

function stripTopLevelFilters(expression: string): string {
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

function getPathValue(value: unknown, segment: string): unknown {
  if (Array.isArray(value)) {
    const axisIndex = ['x', 'y', 'z', 'e'].indexOf(segment.toLowerCase());
    if (axisIndex >= 0) {
      return value[axisIndex];
    }
    if (/^\d+$/.test(segment)) {
      return value[Number(segment)];
    }
    return undefined;
  }

  if (typeof value !== 'object' || value === null) {
    return undefined;
  }

  return (value as Record<string, unknown>)[segment];
}

function maskQuotedStrings(expression: string): string {
  let result = '';
  let quote: '"' | "'" | undefined;
  for (let index = 0; index < expression.length; index++) {
    const char = expression[index];
    if (quote) {
      if (char === '\\') {
        result += ' ';
        index++;
        result += ' ';
        continue;
      }
      if (char === quote) {
        quote = undefined;
        result += char;
        continue;
      }
      result += ' ';
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      result += char;
      continue;
    }

    result += char;
  }
  return result;
}

function previousNonWhitespace(value: string, beforeIndex: number): string | undefined {
  for (let index = beforeIndex - 1; index >= 0; index--) {
    if (!/\s/.test(value[index])) {
      return value[index];
    }
  }
  return undefined;
}

function withKlipperArrayAliases(value: unknown): unknown {
  if (Array.isArray(value)) {
    const copy = value.map((item) => withKlipperArrayAliases(item)) as unknown[] & Record<string, unknown>;
    for (const [index, axis] of ['x', 'y', 'z', 'e'].entries()) {
      if (index < copy.length) {
        copy[axis] = copy[index];
      }
    }
    return copy;
  }

  if (typeof value !== 'object' || value === null) {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, withKlipperArrayAliases(item)])
  );
}
