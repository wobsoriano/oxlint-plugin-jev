import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, onTestFinished, test } from 'vite-plus/test';
import type { JevRule } from '../src/types.ts';
import { startMockJev } from './mock-jev.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(here);
const cacheDir = path.join(root, 'node_modules', '.cache', 'oxlint-plugin-jev');
const RULE_IDS = ['no-pii-in-logs', 'name-matches-behavior', 'no-prompt-injection'];
const pluginPath = path.join(root, 'dist', 'index.mjs');
// vite-plus ships its own LSP-only `oxlint` bin, which shadows the real one in node_modules/.bin.
const oxlintBin = path.join(root, 'node_modules', 'oxlint', 'bin', 'oxlint');

interface LoggedRequest {
  authorization: string;
  body: {
    model: string;
    state: { snippets: Record<string, string> };
    questions: Record<string, { instructions: string }>;
  };
}

interface OxlintSpan {
  line: number;
  column: number;
  length: number;
}

interface OxlintReport {
  diagnostics: { code: string; labels: { span: OxlintSpan }[] }[];
}

// oxlint picks its reporter from the environment, and on Actions runners that is GitHub
// annotations, so the format is named explicitly.
function runOxlint(env: Record<string, string>, format: 'unix' | 'json' | 'default' = 'unix') {
  const clean = { ...process.env };
  delete clean.CI;
  delete clean.TYPESAFE_API_KEY;
  return spawnSync(oxlintBin, ['--format', format, '-c', 'example/.oxlintrc.json', 'example/'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...clean, ...env },
  });
}

const jevLines = (result: SpawnSyncReturns<string>) =>
  result.stdout.split('\n').filter((line) => line.includes('jev(ask)'));

const asked = (logPath: string): LoggedRequest[] =>
  readFileSync(logPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as LoggedRequest);

test('oxlint reports what Jev answered yes to', async () => {
  const { child, logPath, baseURL } = await startMockJev();
  onTestFinished(() => {
    child.kill();
  });
  const withJev = { TYPESAFE_API_KEY: 'test-key', TYPESAFE_BASE_URL: baseURL };

  rmSync(cacheDir, { recursive: true, force: true });
  const first = runOxlint(withJev);

  expect(first.status, `oxlint fails the run\n${first.stdout}${first.stderr}`).toBe(1);
  for (const id of RULE_IDS) {
    expect(first.stdout.includes(`[${id}]`), `${id} is reported\n${first.stdout}`).toBe(true);
  }
  expect(
    jevLines(first),
    `the messageId renders the id, the model that answered, both numbers at two decimals, and the question\n${first.stdout}`,
  ).toContain(
    'example/fail.js:5:3: [no-pii-in-logs] jev-mock answered yes (0.95 >= 0.80): Does this call write personal data, such as an email or phone number, to a log or console? [Error/jev(ask)]',
  );
  expect(
    jevLines(first).length,
    'every reported rule has its own diagnostic',
  ).toBeGreaterThanOrEqual(RULE_IDS.length);
  for (const line of jevLines(first)) {
    expect(line, 'Jev diagnostics only land on fail.js').toMatch(/example\/fail\.js/);
  }
  expect(
    jevLines(first).filter((line) => line.includes('pass.js')).length,
    'pass.js is clean',
  ).toBe(0);

  const requests = asked(logPath);
  expect(requests.length, 'one request per linted file').toBe(2);
  for (const request of requests) {
    expect(request.authorization, 'the API key is sent as a bearer token').toBe('Bearer test-key');
  }
  const snippetsOf = (request: LoggedRequest) => Object.values(request.body.state.snippets);
  const forFail = requests.find((request) => snippetsOf(request).some((s) => s.includes('loaded')));
  const forPass = requests.find((request) => request !== forFail);
  expect(forFail, 'fail.js was asked about').toBeDefined();
  expect(forPass, 'pass.js was asked about').toBeDefined();
  expect(
    Object.keys(forFail?.body.questions ?? {}).length,
    'fail.js asks about at least 3 snippets',
  ).toBeGreaterThanOrEqual(3);
  expect(
    Object.keys(forPass?.body.questions ?? {}).length,
    'pass.js asks about at least 1 snippet',
  ).toBeGreaterThanOrEqual(1);
  expect(forFail?.body.model, 'the default model is sent').toBe('jev-latest');

  const second = runOxlint(withJev);
  expect(asked(logPath).length, 'a cached file is not asked about again').toBe(2);
  expect(second.status, 'a cached run still fails').toBe(1);
  expect(jevLines(second), 'a cached run reports the same diagnostics').toEqual(jevLines(first));

  for (const entry of readdirSync(cacheDir)) writeFileSync(path.join(cacheDir, entry), '{}');
  const third = runOxlint(withJev);
  expect(
    asked(logPath).length,
    'a malformed cache entry is a miss, so both files are asked about again',
  ).toBe(4);
  expect(
    jevLines(third),
    'a run over malformed cache entries reports the same diagnostics',
  ).toEqual(jevLines(first));

  const report = JSON.parse(runOxlint(withJev, 'json').stdout) as OxlintReport;
  const spans = report.diagnostics
    .filter((diagnostic) => diagnostic.code === 'jev(ask)')
    .map((diagnostic) => diagnostic.labels[0].span);
  const failLines = readFileSync(path.join(root, 'example', 'fail.js'), 'utf8').split('\n');
  const spanAt = (line: number): OxlintSpan => {
    const span = spans.find((candidate) => candidate.line === line);
    if (span === undefined) throw new Error(`no jev diagnostic on line ${line}`);
    return span;
  };
  expect(spanAt(3).length, 'a function hit underlines only its signature line').toBe(
    failLines[2].length - spanAt(3).column + 1,
  );
  expect(spanAt(5).length, 'a call hit underlines the whole call').toBe(
    'console.log("loaded", user.email, user.phone)'.length,
  );
});

test('a missing key fails the run under CI when ci is fail', () => {
  rmSync(cacheDir, { recursive: true, force: true });
  const result = runOxlint({ CI: '1' }, 'default');
  expect(result.status, 'oxlint fails the run').not.toBe(0);
  expect(`${result.stdout}${result.stderr}`, 'the missing key is named').toMatch(
    /TYPESAFE_API_KEY/,
  );
});

test('a missing key outside CI warns and skips', () => {
  rmSync(cacheDir, { recursive: true, force: true });
  const result = runOxlint({});
  expect(result.status, `oxlint passes the run\n${result.stdout}${result.stderr}`).toBe(0);
  expect(result.stderr, 'the missing key is named on stderr').toMatch(/TYPESAFE_API_KEY/);
  expect(jevLines(result), 'nothing is reported without a key').toEqual([]);
});

test('two files with the same text but different parses are asked about separately', async () => {
  const project = mkdtempSync(path.join(tmpdir(), 'jev-twins-'));
  const { child, logPath, baseURL } = await startMockJev();
  onTestFinished(() => {
    child.kill();
  });
  const callRule: JevRule = {
    id: 'any-call',
    target: 'call',
    question: 'Is this call bad?',
    cutoff: 0.8,
  };
  writeFileSync(
    path.join(project, '.oxlintrc.json'),
    JSON.stringify({
      jsPlugins: [pluginPath],
      rules: { 'jev/ask': ['error', { rules: [callRule] }] },
    }),
  );
  const text = 'first();\nf<T>(x);\nlast();\n';
  writeFileSync(path.join(project, 'same.js'), text);
  writeFileSync(path.join(project, 'same.ts'), text);

  const clean = { ...process.env };
  delete clean.CI;
  const result = spawnSync(oxlintBin, ['-c', '.oxlintrc.json', 'same.js', 'same.ts'], {
    cwd: project,
    encoding: 'utf8',
    env: { ...clean, TYPESAFE_API_KEY: 'test-key', TYPESAFE_BASE_URL: baseURL },
  });
  expect(result.status, `oxlint runs both files\n${result.stdout}${result.stderr}`).toBe(0);
  const counts = asked(logPath)
    .map((request) => Object.keys(request.body.questions).length)
    .sort((a, b) => a - b);
  expect(
    counts,
    'the .js parse sees two calls and the .ts parse sees three, so each file gets its own request',
  ).toEqual([2, 3]);
});

test('a file over maxMatchesPerFile is capped and named on stderr', async () => {
  const project = mkdtempSync(path.join(tmpdir(), 'jev-capped-'));
  const { child, logPath, baseURL } = await startMockJev();
  onTestFinished(() => {
    child.kill();
  });
  const piiRule: JevRule = {
    id: 'no-pii-in-logs',
    target: 'call',
    question: 'Does this call write personal data to a log?',
    cutoff: 0.8,
  };
  writeFileSync(
    path.join(project, '.oxlintrc.json'),
    JSON.stringify({
      jsPlugins: [pluginPath],
      rules: { 'jev/ask': ['error', { maxMatchesPerFile: 25, rules: [piiRule] }] },
    }),
  );
  writeFileSync(
    path.join(project, 'rows.js'),
    `${Array.from({ length: 30 }, () => 'console.log("row", user.email, user.phone);').join('\n')}\n`,
  );

  const clean = { ...process.env };
  delete clean.CI;
  const result = spawnSync(oxlintBin, ['--format', 'unix', '-c', '.oxlintrc.json', 'rows.js'], {
    cwd: project,
    encoding: 'utf8',
    env: { ...clean, TYPESAFE_API_KEY: 'test-key', TYPESAFE_BASE_URL: baseURL },
  });
  const requests = asked(logPath);
  expect(requests.length, 'the file is asked about once').toBe(1);
  expect(Object.keys(requests[0].body.questions).length, 'only the first 25 matches are sent').toBe(
    25,
  );
  expect(result.stderr, `the dropped tail is counted on stderr\n${result.stderr}`).toContain(
    '30 matches exceeded maxMatchesPerFile=25, 5 not checked',
  );
  expect(result.stderr, 'the capped file is named on stderr').toContain('rows.js');
  expect(jevLines(result).length, 'the 25 sent matches are still reported').toBe(25);
  expect(result.status, 'the cap does not change the exit code').toBe(1);
});

function runWithOptions(options: unknown) {
  const config = path.join(mkdtempSync(path.join(tmpdir(), 'jev-config-')), '.oxlintrc.json');
  writeFileSync(
    config,
    JSON.stringify({ jsPlugins: [pluginPath], rules: { 'jev/ask': ['error', options] } }),
  );
  const clean = { ...process.env };
  delete clean.CI;
  delete clean.TYPESAFE_API_KEY;
  return spawnSync(oxlintBin, ['--format', 'default', '-c', config, 'example/pass.js'], {
    cwd: root,
    encoding: 'utf8',
    env: clean,
  });
}

const goodRule: JevRule = { id: 'a', target: 'call', question: 'Is it bad?', cutoff: 0.8 };

const badConfigs: [string, unknown, string][] = [
  [
    'location is configured for a non-file rule',
    { rules: [{ ...goodRule, location: { question: 'Where?', cutoff: 0.75 } }] },
    'location is supported only for file rules',
  ],
  ...[0.5, 1.01].map((cutoff): [string, unknown, string] => [
    `a location cutoff is outside (0.5, 1]: ${cutoff}`,
    { rules: [{ ...goodRule, target: 'file', location: { question: 'Where?', cutoff } }] },
    'cutoff',
  ]),
  [
    'a target is not one the plugin knows',
    { rules: [{ ...goodRule, target: 'class' }] },
    'Value "class" should be equal to one of the allowed values.',
  ],
  [
    'a plugin-level field is unknown',
    { foo: 1, rules: [goodRule] },
    'Unexpected property "foo". Expected properties: "ci", "timeoutMs", "maxMatchesPerFile", "maxSnippetChars", "model", "rules".',
  ],
  [
    'two rules share an id',
    { rules: [goodRule, { ...goodRule, target: 'file', question: 'Other?' }] },
    'oxlint-plugin-jev: rule id "a" is used more than once',
  ],
];

for (const [name, options, expected] of badConfigs) {
  test(`oxlint refuses a config where ${name}`, () => {
    const result = runWithOptions(options);
    const output = `${result.stdout}${result.stderr}`;
    expect(result.status, `oxlint fails the run\n${output}`).not.toBe(0);
    expect(output.includes(expected), `the error names the problem\n${output}`).toBe(true);
  });
}
