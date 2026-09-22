import type { Location } from '@oxlint/plugins';
import { expect, test } from 'vite-plus/test';
import {
  checkOptions,
  DEFAULTS,
  NAMED_PARENTS,
  type NamedField,
  REPORT_LOC,
  SCHEMA,
  snippetNodeFor,
  TARGET_NODE_TYPES,
} from '../src/options.ts';
import type { JevRule, NamedParent } from '../src/types.ts';

const rule: JevRule = { id: 'a', target: 'call', question: 'Is it bad?', cutoff: 0.8 };
const withRules = (...rules: JevRule[]) => ({ ...DEFAULTS, rules });

test('returns the merged options oxlint handed it, untouched', () => {
  const merged = withRules(rule);
  expect(checkOptions(merged), 'the same object comes back, not a copy').toBe(merged);
});

test('rejects options where rules is missing', () => {
  expect(() => checkOptions({ ...DEFAULTS })).toThrow(
    /^oxlint-plugin-jev: options\.rules must list at least one rule$/,
  );
});

test('rejects options where two rules share an id', () => {
  expect(() => checkOptions(withRules(rule, { ...rule, target: 'file' }))).toThrow(
    /^oxlint-plugin-jev: rule id "a" is used more than once$/,
  );
});

test('accepts distinct ids across rules', () => {
  expect(() => checkOptions(withRules(rule, { ...rule, id: 'b' }))).not.toThrow();
});

test.each(['function', 'call', 'jsx'] as const)(
  'rejects a location question on a %s rule',
  (target) => {
    expect(() =>
      checkOptions(withRules({ ...rule, target, location: { question: 'Where?', cutoff: 0.75 } })),
    ).toThrow('location is supported only for file rules');
  },
);

test('accepts a location question on a file rule', () => {
  expect(() =>
    checkOptions(
      withRules({ ...rule, target: 'file', location: { question: 'Where?', cutoff: 0.75 } }),
    ),
  ).not.toThrow();
});

test('maps every target to the node types the README documents', () => {
  expect(TARGET_NODE_TYPES).toEqual({
    function: ['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'],
    call: ['CallExpression'],
    jsx: ['JSXElement'],
    file: ['Program'],
  });
});

test('defaults the plugin fields the README documents', () => {
  expect(DEFAULTS).toEqual({
    ci: 'skip',
    timeoutMs: 10000,
    maxMatchesPerFile: 25,
    maxSnippetChars: 4000,
    model: 'jev-latest',
  });
});

test('offers every default as a schema property, so a default is never an unknown field', () => {
  for (const field of Object.keys(DEFAULTS)) {
    expect(Object.hasOwn(SCHEMA.properties, field), `${field} is in the schema`).toBe(true);
  }
});

test('leaves rules optional in the schema, since oxlint validates the defaults against it', () => {
  expect(Object.hasOwn(SCHEMA, 'required'), 'a required rules field would break plugin load').toBe(
    false,
  );
});

test("offers exactly the documented targets as the schema's target enum", () => {
  expect(SCHEMA.properties.rules.items.properties.target.enum).toEqual(
    Object.keys(TARGET_NODE_TYPES),
  );
});

test('requires all four per-rule fields in the schema', () => {
  expect(SCHEMA.properties.rules.items.required).toEqual(['id', 'target', 'question', 'cutoff']);
});

test('closes both objects to unknown fields', () => {
  expect(SCHEMA.additionalProperties).toBe(false);
  expect(SCHEMA.properties.rules.items.additionalProperties).toBe(false);
});

const at = (line: number, column: number): Location => ({
  start: { line, column },
  end: { line, column },
});

const fn = { loc: { start: { line: 10, column: 7 }, end: { line: 16, column: 1 } } };

test('a function is reported on its signature line only', () => {
  expect(REPORT_LOC.function(fn, 'function readConfig(path) {\n  return 1;\n}')).toEqual({
    start: { line: 10, column: 7 },
    end: { line: 10, column: 7 + 'function readConfig(path) {'.length },
  });
});

const anywhere = { loc: at(9, 4) };

test('a whole-file match is reported on the first line only', () => {
  expect(REPORT_LOC.file(anywhere, 'import x from "y";\n\nx();')).toEqual({
    start: { line: 1, column: 0 },
    end: { line: 1, column: 'import x from "y";'.length },
  });
});

test('a one-line snippet is reported to its end', () => {
  expect(REPORT_LOC.file(anywhere, 'x();').end.column).toBe(4);
});

test('a call is reported on the whole call and JSX on its opening element', () => {
  const loc: Location = { start: { line: 3, column: 2 }, end: { line: 3, column: 9 } };
  expect(REPORT_LOC.call({ loc })).toBe(loc);
  expect(REPORT_LOC.jsx({ loc: at(3, 0), openingElement: { loc } })).toBe(loc);
});

test("names the parents that carry an anonymous function's binding or method name", () => {
  expect(NAMED_PARENTS).toEqual({
    VariableDeclarator: 'init',
    Property: 'value',
    MethodDefinition: 'value',
    PropertyDefinition: 'value',
  });
});

interface Fixture {
  type: string;
  range: [number, number];
  parent?: NamedParent | null;
}

const childOf = (
  parentType: string,
  field: NamedField,
  functionType = 'ArrowFunctionExpression',
): Fixture => {
  const node: Fixture = { type: functionType, range: [0, 0] };
  node.parent = { type: parentType, range: [0, 0], [field]: node };
  return node;
};

for (const [parentType, field] of Object.entries(NAMED_PARENTS)) {
  test(`sends the whole ${parentType} for an arrow function stored in its ${field}`, () => {
    const node = childOf(parentType, field);
    expect(snippetNodeFor(node)).toBe(node.parent);
  });
}

test('sends the whole declarator for a function expression too', () => {
  const node = childOf('VariableDeclarator', 'init', 'FunctionExpression');
  expect(snippetNodeFor(node)).toBe(node.parent);
});

test('sends the function itself when its parent is not one that names it', () => {
  const node: Fixture = { type: 'ArrowFunctionExpression', range: [0, 0] };
  node.parent = { type: 'CallExpression', range: [0, 0] };
  expect(snippetNodeFor(node)).toBe(node);
});

test('sends the function itself when it sits in a field other than the named one', () => {
  const node: Fixture = { type: 'ArrowFunctionExpression', range: [0, 0] };
  node.parent = { type: 'Property', range: [0, 0], value: { type: 'Other', range: [0, 0] } };
  expect(snippetNodeFor(node)).toBe(node);
});

test('sends the function itself when it has no parent', () => {
  const node: Fixture = { type: 'ArrowFunctionExpression', range: [0, 0] };
  expect(snippetNodeFor(node)).toBe(node);
});

test('leaves a call inside a declarator alone, since only anonymous functions lose a name', () => {
  const node = childOf('VariableDeclarator', 'init', 'CallExpression');
  expect(snippetNodeFor(node)).toBe(node);
});
