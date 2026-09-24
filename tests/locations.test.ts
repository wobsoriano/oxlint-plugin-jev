import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, onTestFinished, test } from 'vite-plus/test';
import type { JevOptions, JevRequest, JevRule } from '../src/types.ts';
import { startMockJev } from './mock-jev.ts';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const oxlintBin = path.join(root, 'node_modules', 'oxlint', 'bin', 'oxlint');
const source =
  '// Context 🐱\nexport function logUser(user) {\n\n\tconsole.log(user.email, user.phone);  \n}\n';
const rule: JevRule = {
  id: 'no-personal-data',
  target: 'file',
  question: 'Does this file log personal data?',
  cutoff: 0.9,
  location: { question: 'Select the call that logs personal data.', cutoff: 0.75 },
};

interface Diagnostic {
  code: string;
  message: string;
  labels: { span: { offset: number; line: number; column: number; length: number } }[];
}

async function project(text = source, options: Partial<JevOptions> = {}, token = 'test-key') {
  const cwd = mkdtempSync(path.join(tmpdir(), 'jev-locations-'));
  const { child, logPath, baseURL } = await startMockJev();
  onTestFinished(() => {
    child.kill();
    rmSync(cwd, { recursive: true, force: true });
  });
  writeFileSync(path.join(cwd, 'source.ts'), text);
  writeFileSync(
    path.join(cwd, '.oxlintrc.json'),
    JSON.stringify({
      jsPlugins: [path.join(root, 'dist', 'index.mjs')],
      rules: {
        'jev/ask': ['error', { ci: 'fail', maxSnippetChars: 64000, rules: [rule], ...options }],
      },
    }),
  );
  return {
    cwd,
    requests: (): JevRequest[] =>
      readFileSync(logPath, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => (JSON.parse(line) as { body: JevRequest }).body),
    lint() {
      const result = spawnSync(
        oxlintBin,
        [
          '--threads=1',
          '--disable-nested-config',
          '--format=json',
          '-c',
          '.oxlintrc.json',
          'source.ts',
        ],
        {
          cwd,
          encoding: 'utf8',
          env: { ...process.env, CI: '1', TYPESAFE_API_KEY: token, TYPESAFE_BASE_URL: baseURL },
        },
      );
      const report = JSON.parse(result.stdout) as { diagnostics: Diagnostic[] };
      return {
        ...result,
        diagnostics: report.diagnostics.filter((diagnostic) => diagnostic.code === 'jev(ask)'),
      };
    },
  };
}

test.each(['\n', '\r\n', '\r', '\u2028', '\u2029'])(
  'reports the suspected source span across line terminators (%j)',
  async (newline) => {
    const text = source.replaceAll('\n', newline);
    const fixture = await project(text);
    const result = fixture.lint();
    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(result.diagnostics).toHaveLength(1);
    const span = result.diagnostics[0].labels[0].span;
    expect(span).toMatchObject({
      offset: Buffer.byteLength(text.slice(0, text.indexOf('console'))),
      length: 'console.log(user.email, user.phone);'.length,
    });
    // Oxlint's JSON reporter counts Unicode line separators differently from its JS source API.
    if (newline !== '\u2028' && newline !== '\u2029') {
      expect(span).toMatchObject({ line: 4, column: 2 });
    }
    expect(fixture.requests()).toHaveLength(1);
    expect(fixture.requests()[0].state.snippets.s0).toContain('L4| \tconsole.log');
  },
);

test('keeps the request and location unchanged without a location question', async () => {
  const { location: _location, ...withoutLocation } = rule;
  const fixture = await project(source, { rules: [withoutLocation] });
  expect(fixture.lint().diagnostics[0].labels[0].span.line).toBe(1);
  expect(fixture.requests()[0].state.snippets.s0).toBe(source);
  expect(Object.keys(fixture.requests()[0].questions)).toEqual(['s0']);
});

test.each(['fail', 'skip'] as const)(
  'never locates truncated snippets or their synthetic marker (ci=%s)',
  async (ci) => {
    for (const maxSnippetChars of [
      source.indexOf('console') + 10,
      source.indexOf('\tconsole'),
      source.length - 1,
    ]) {
      const fixture = await project(source, { ci, maxSnippetChars }, 'location-always-positive');
      const result = fixture.lint();
      expect(result.status, result.stdout + result.stderr).toBe(1);
      expect(result.diagnostics).toHaveLength(1);
      expect(result.diagnostics[0].labels[0].span.line).toBe(1);
      expect(Object.keys(fixture.requests()[0].questions)).toEqual(['s0']);
    }
  },
);

test.each(['location-uncertain', 'location-unknown'])(
  'caches a valid uncertain answer and reports at file level (%s)',
  async (token) => {
    const fixture = await project(source, {}, token);
    const first = fixture.lint();
    expect(first.status).toBe(1);
    expect(first.diagnostics[0].labels[0].span.line).toBe(1);
    expect(fixture.lint().diagnostics).toEqual(first.diagnostics);
    expect(fixture.requests()).toHaveLength(1);
  },
);

const largeSource = '// Context\n'.repeat(600) + source;

test('a confident location cannot create a violation or trigger refinement by itself', async () => {
  const fixture = await project(largeSource, {}, 'location-no-violation');
  const result = fixture.lint();
  expect(result.status, result.stdout + result.stderr).toBe(0);
  expect(result.diagnostics).toEqual([]);
  expect(fixture.requests()).toHaveLength(1);
});

test('refines a large-file range with full context and caches both requests', async () => {
  const fixture = await project(largeSource);
  const first = fixture.lint();
  expect(first.status).toBe(1);
  expect(first.diagnostics[0].labels[0].span.line).toBe(604);
  expect(fixture.requests()).toHaveLength(2);
  expect(fixture.requests()[1].state).toEqual(fixture.requests()[0].state);
  expect(fixture.lint().diagnostics).toEqual(first.diagnostics);
  expect(fixture.requests()).toHaveLength(2);
});

test('a failed refinement preserves later findings without sending more requests', async () => {
  const fixture = await project(
    largeSource,
    {
      rules: [rule, { ...rule, id: 'another-file-rule' }],
    },
    'refinement-fails',
  );
  const result = fixture.lint();
  expect(result.status).toBe(1);
  expect(result.diagnostics).toHaveLength(3);
  for (const id of [rule.id, 'another-file-rule']) {
    const finding = result.diagnostics.find((diagnostic) =>
      diagnostic.message.startsWith(`[${id}]`),
    );
    expect(finding?.labels[0].span.line).toBe(1);
  }
  expect(fixture.requests()).toHaveLength(2);
});

test.each(['fail', 'skip'] as const)(
  'preserves confirmed findings when refinement fails (ci=%s)',
  async (ci) => {
    for (const token of ['refinement-fails', 'refinement-slow']) {
      const fixture = await project(largeSource, { ci, timeoutMs: 1500 }, token);
      const result = fixture.lint();
      expect(result.status, result.stdout + result.stderr).toBe(1);
      const finding = result.diagnostics.find((diagnostic) =>
        diagnostic.message.startsWith('[no-personal-data]'),
      );
      expect(finding?.labels[0].span.line).toBe(1);
      expect(result.stdout + result.stderr).toMatch(
        token === 'refinement-slow' ? /timeout/ : /401/,
      );
      expect(result.diagnostics).toHaveLength(ci === 'fail' ? 2 : 1);
      expect(fixture.requests()).toHaveLength(2);
    }
  },
);

test.each(['location-missing-once', 'refinement-missing-once'])(
  'retries a malformed location answer on the next run (%s)',
  async (token) => {
    const fixture = await project(token.startsWith('refinement') ? largeSource : source, {}, token);
    expect(fixture.lint().diagnostics[0].labels[0].span.line).toBe(1);
    expect(fixture.lint().diagnostics[0].labels[0].span.line).toBe(
      token.startsWith('refinement') ? 604 : 4,
    );
    expect(fixture.requests()).toHaveLength(token.startsWith('refinement') ? 3 : 2);
  },
);

test('retries malformed refinement answers already on disk', async () => {
  const fixture = await project(largeSource);
  expect(fixture.lint().diagnostics[0].labels[0].span.line).toBe(604);
  const cache = path.join(fixture.cwd, 'node_modules', '.cache', 'oxlint-plugin-jev');
  let corrupted = 0;
  for (const name of readdirSync(cache)) {
    const entryPath = path.join(cache, name);
    const entry = JSON.parse(readFileSync(entryPath, 'utf8')) as {
      answers: Record<string, unknown>;
    };
    if (!entry.answers.s0) {
      entry.answers.s0_location = { type: 'choice', choice: 'L604' };
      writeFileSync(entryPath, JSON.stringify(entry));
      corrupted++;
    }
  }
  expect(corrupted).toBe(1);
  expect(fixture.lint().diagnostics[0].labels[0].span.line).toBe(604);
  expect(fixture.requests()).toHaveLength(3);
});
