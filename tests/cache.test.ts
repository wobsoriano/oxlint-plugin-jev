import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from 'vite-plus/test';
import { defaultCacheDir, readCache, writeCache } from '../src/cache.ts';

const scratch = () => mkdtempSync(path.join(tmpdir(), 'jev-cache-'));
const key = 'a'.repeat(64);
const model = 'jev-mock';
const response = (verdicts: Record<string, unknown>) => ({
  model,
  answers: Object.fromEntries(
    Object.entries(verdicts).map(([ref, noul]) => [ref, { type: 'noul', noul }]),
  ),
});
const store = (dir: string, text: string) => writeFileSync(path.join(dir, `${key}.json`), text);

test('lives under node_modules/.cache in the working directory', () => {
  expect(defaultCacheDir()).toBe(
    path.join(process.cwd(), 'node_modules', '.cache', 'oxlint-plugin-jev'),
  );
});

test('reads the verdicts back out of a stored response', () => {
  const dir = scratch();
  writeCache(dir, key, response({ s0: 0.93, s1: 0.12 }));
  expect(readCache(dir, key, ['s0', 's1'])).toEqual({
    model,
    scores: { s0: 0.93, s1: 0.12 },
    answers: response({ s0: 0.93, s1: 0.12 }).answers,
    complete: true,
  });
});

test('creates the cache directory on first write', () => {
  const dir = path.join(scratch(), 'nested', 'deeper');
  writeCache(dir, key, response({ s0: 1 }));
  expect(readCache(dir, key, ['s0'])).toEqual({
    model,
    scores: { s0: 1 },
    answers: response({ s0: 1 }).answers,
    complete: true,
  });
});

test('leaves no temporary file behind', () => {
  const dir = scratch();
  writeCache(dir, key, response({ s0: 1 }));
  expect(readdirSync(dir)).toEqual([`${key}.json`]);
});

test('overwrites an earlier entry for the same key', () => {
  const dir = scratch();
  writeCache(dir, key, response({ s0: 0.1 }));
  writeCache(dir, key, response({ s0: 0.9 }));
  expect(readCache(dir, key, ['s0'])).toEqual({
    model,
    scores: { s0: 0.9 },
    answers: response({ s0: 0.9 }).answers,
    complete: true,
  });
});

test('misses when the entry does not exist', () => {
  expect(readCache(scratch(), key, ['s0'])).toBe(null);
});

test('misses when the directory does not exist', () => {
  expect(readCache(path.join(scratch(), 'absent'), key, ['s0'])).toBe(null);
});

test('misses when the entry is not valid json', () => {
  const dir = scratch();
  store(dir, '{ half-written');
  expect(readCache(dir, key, ['s0'])).toBe(null);
  expect(
    existsSync(path.join(dir, `${key}.json`)),
    'the bad entry is left for the next write to replace',
  ).toBe(true);
});

const malformedEntries = [
  ['an empty object', '{}'],
  ['a bare verdict map instead of a response', JSON.stringify({ s0: 0.9 })],
  ['a string where the probability should be', JSON.stringify(response({ s0: '0.9' }))],
  ['an answer for a different ref', JSON.stringify(response({ s1: 0.9 }))],
  ['a response without a model id', JSON.stringify({ answers: response({ s0: 0.9 }).answers })],
] as const;

for (const [name, text] of malformedEntries) {
  test(`misses when the entry is ${name}, since a cache entry gets the same checks as a response`, () => {
    const dir = scratch();
    store(dir, text);
    expect(readCache(dir, key, ['s0'])).toBe(null);
  });
}
