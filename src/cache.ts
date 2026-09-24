import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseVerdicts } from './jev.ts';
import type { ChoiceQuestions, Verdicts } from './types.ts';

export const defaultCacheDir = (): string =>
  path.join(process.cwd(), 'node_modules', '.cache', 'oxlint-plugin-jev');

export function readCache(
  dir: string,
  key: string,
  refs: readonly string[],
  choices: ChoiceQuestions = {},
): Verdicts | null {
  try {
    const stored: unknown = JSON.parse(readFileSync(path.join(dir, `${key}.json`), 'utf8'));
    const verdicts = parseVerdicts(stored, refs, choices);
    return verdicts.complete ? verdicts : null;
  } catch {
    return null;
  }
}

export function writeCache(dir: string, key: string, response: unknown): void {
  const target = path.join(dir, `${key}.json`);
  const temp = `${target}.tmp-${process.pid}`;
  mkdirSync(dir, { recursive: true });
  writeFileSync(temp, JSON.stringify(response));
  renameSync(temp, target);
}
