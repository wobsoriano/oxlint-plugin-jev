import type { Location, RuleOptionsSchema } from '@oxlint/plugins';
import type { ReportNode, ResolvedOptions, SnippetNode, Target } from './types.ts';

export const TARGET_NODE_TYPES = {
  function: ['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'],
  call: ['CallExpression'],
  jsx: ['JSXElement'],
  file: ['Program'],
} satisfies Record<Target, string[]>;

// An anonymous function in one of these fields inherits its name from the parent's text.
export const NAMED_PARENTS = {
  VariableDeclarator: 'init',
  Property: 'value',
  MethodDefinition: 'value',
  PropertyDefinition: 'value',
} as const;

export type NamedField = (typeof NAMED_PARENTS)[keyof typeof NAMED_PARENTS];

const isNamedParentType = (type: string): type is keyof typeof NAMED_PARENTS =>
  type in NAMED_PARENTS;

const ANONYMOUS_FUNCTIONS = new Set(['FunctionExpression', 'ArrowFunctionExpression']);

export function snippetNodeFor(node: SnippetNode): SnippetNode {
  const parent = node.parent;
  if (parent === null || parent === undefined) return node;
  const parentType = parent.type;
  if (!isNamedParentType(parentType)) return node;
  const field = NAMED_PARENTS[parentType];
  return ANONYMOUS_FUNCTIONS.has(node.type) && parent[field] === node ? parent : node;
}

export const DEFAULTS = {
  ci: 'skip',
  timeoutMs: 10000,
  maxMatchesPerFile: 25,
  maxSnippetChars: 4000,
  model: 'jev-latest',
} satisfies Omit<ResolvedOptions, 'rules'>;

// `rules` is absent from DEFAULTS and oxlint validates DEFAULTS against this schema at
// plugin load, so `required: ["rules"]` here would stop the plugin loading at all.
export const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ci: { enum: ['skip', 'fail'] },
    timeoutMs: { type: 'integer', minimum: 1 },
    maxMatchesPerFile: { type: 'integer', minimum: 1 },
    maxSnippetChars: { type: 'integer', minimum: 1 },
    model: { type: 'string', minLength: 1 },
    rules: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'target', 'question', 'cutoff'],
        properties: {
          id: { type: 'string', minLength: 1 },
          target: { enum: Object.keys(TARGET_NODE_TYPES) },
          question: { type: 'string', minLength: 1 },
          location: {
            type: 'object',
            additionalProperties: false,
            required: ['question', 'cutoff'],
            properties: {
              question: { type: 'string', minLength: 1 },
              cutoff: { type: 'number', minimum: 0.5, exclusiveMinimum: true, maximum: 1 },
            },
          },
          cutoff: { type: 'number', minimum: 0, maximum: 1 },
        },
      },
    },
  },
} satisfies RuleOptionsSchema;

function fail(message: string): never {
  throw new Error(`oxlint-plugin-jev: ${message}`);
}

// oxlint validates `context.options` against SCHEMA before a rule sees it, so the only checks
// left are the ones a JSON schema cannot express.
export function checkOptions(raw: unknown): ResolvedOptions {
  if (typeof raw !== 'object' || raw === null) fail('options must be an object');
  const options = raw as ResolvedOptions;
  if (!Array.isArray(options.rules)) fail('options.rules must list at least one rule');
  const seen = new Set<string>();
  for (const { id, target, location } of options.rules) {
    if (location && target !== 'file') fail('location is supported only for file rules');
    if (seen.has(id)) fail(`rule id "${id}" is used more than once`);
    seen.add(id);
  }
  return options;
}

function headOf(text: string, line: number, column: number): Location {
  const newline = text.indexOf('\n');
  const length = newline === -1 ? text.length : newline;
  return { start: { line, column }, end: { line, column: column + length } };
}

export const REPORT_LOC = {
  function: (node: ReportNode, text: string): Location =>
    headOf(text, node.loc.start.line, node.loc.start.column),
  call: (node: ReportNode): Location => node.loc,
  jsx: (node: ReportNode): Location => (node.openingElement ?? node).loc,
  file: (_node: ReportNode, text: string): Location => headOf(text, 1, 0),
} satisfies Record<Target, (node: ReportNode, text: string) => Location>;
