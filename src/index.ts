import type {
  Context,
  ESTree,
  Location,
  Plugin,
  RuleMeta,
  SourceCode,
  VisitorWithHooks,
} from '@oxlint/plugins';
import { ENV } from '@typesafe-ai/sdk';
import { defaultCacheDir, readCache, writeCache } from './cache.ts';
import {
  buildRequest,
  cacheKey,
  choiceQuestionsOf,
  locates,
  locationCandidates,
  locationOfLine,
  locationQuestion,
  messageOf,
  parseVerdicts,
  refAt,
  selectedLocation,
  truncateSnippet,
} from './jev.ts';
import {
  checkOptions,
  DEFAULTS,
  REPORT_LOC,
  SCHEMA,
  snippetNodeFor,
  TARGET_NODE_TYPES,
} from './options.ts';
import { askJev } from './sync-jev.ts';
import type {
  JevPlugin,
  JevRequest,
  JevRule,
  Match,
  ResolvedOptions,
  VerdictResult,
  Verdicts,
} from './types.ts';

export type { CiBehavior, JevOptions, JevPlugin, JevRule, Target } from './types.ts';

const optionsByRaw = new WeakMap<object, ResolvedOptions>();
const warnedReasons = new Set<string>();
let missingKeyRaised = false;

function warnOnce(reason: string, message: string): void {
  if (warnedReasons.has(reason)) return;
  warnedReasons.add(reason);
  console.warn(`oxlint-plugin-jev: ${message}`);
}

const DEFAULT_BASE_URL = 'https://api.typesafe.ai';

const baseURL = (): string =>
  ((process.env[ENV.baseURL] ?? '').trim() || DEFAULT_BASE_URL).replace(/\/+$/, '');

const snippetOf = (sourceCode: SourceCode, node: ESTree.Node): string =>
  node.type === 'Program' ? sourceCode.text : sourceCode.getText(node);

function optionsFor(raw: unknown): ResolvedOptions {
  if (typeof raw !== 'object' || raw === null) return checkOptions(raw);
  const cached = optionsByRaw.get(raw);
  if (cached !== undefined) return cached;
  const options = checkOptions(raw);
  optionsByRaw.set(raw, options);
  return options;
}

function rulesByNodeType(rules: readonly JevRule[]): Map<string, JevRule[]> {
  const byType = new Map<string, JevRule[]>();
  for (const rule of rules) {
    for (const type of TARGET_NODE_TYPES[rule.target]) {
      byType.set(type, [...(byType.get(type) ?? []), rule]);
    }
  }
  return byType;
}

function degrade(context: Context, options: ResolvedOptions, reason: string): null {
  if (process.env.CI && options.ci === 'fail') {
    throw new Error(`oxlint-plugin-jev: ${reason} (${context.filename})`);
  }
  warnOnce(reason, `${reason} (${context.filename})`);
  return null;
}

function fetchVerdicts(
  options: ResolvedOptions,
  request: JevRequest,
  refs: readonly string[],
  apiKey: string,
): VerdictResult {
  const dir = defaultCacheDir();
  const url = baseURL();
  const key = cacheKey({ endpoint: url, request });
  const choices = choiceQuestionsOf(request);
  const cached = readCache(dir, key, refs, choices);
  if (cached !== null) return { ok: true, verdicts: cached };

  const result = askJev({ apiKey, baseURL: url, request, timeoutMs: options.timeoutMs });
  if (!result.ok) return result;
  let verdicts: Verdicts;
  try {
    verdicts = parseVerdicts(result.json, refs, choices);
  } catch (error) {
    return { ok: false, reason: messageOf(error) };
  }
  if (verdicts.complete) {
    try {
      writeCache(dir, key, result.json);
    } catch (error) {
      warnOnce('cache-write', `could not write cache in ${dir}: ${messageOf(error)}`);
    }
  }
  return { ok: true, verdicts };
}

function verdictsFor(
  context: Context,
  options: ResolvedOptions,
  matches: readonly Match[],
  apiKey: string,
  request: JevRequest,
): Verdicts | null {
  const result = fetchVerdicts(
    options,
    request,
    matches.map((_, index) => refAt(index)),
    apiKey,
  );
  return result.ok ? result.verdicts : degrade(context, options, result.reason);
}

interface LocatedResult {
  loc: Location;
  failure?: string;
}

function locateMatch(
  options: ResolvedOptions,
  match: Match,
  index: number,
  verdicts: Verdicts,
  request: JevRequest,
  apiKey: string,
  deadline: number,
): LocatedResult {
  if (!locates(match)) return { loc: match.loc };
  const ref = refAt(index);
  const questionId = `${ref}_location`;
  let candidates = locationCandidates(match.snippet);
  let location = selectedLocation(
    verdicts.answers[questionId],
    candidates,
    match.rule.location.cutoff,
  );
  while (location && location.start !== location.end) {
    candidates = locationCandidates(match.snippet, location);
    const followup = {
      model: options.model,
      state: request.state,
      questions: { [questionId]: locationQuestion(match, ref, candidates) },
    };
    const remaining = { ...options, timeoutMs: Math.max(1, deadline - Date.now()) };
    const refined = fetchVerdicts(remaining, followup, [], apiKey);
    if (!refined.ok) return { loc: match.loc, failure: refined.reason };
    location = selectedLocation(
      refined.verdicts.answers[questionId],
      candidates,
      match.rule.location.cutoff,
    );
  }
  return { loc: location ? locationOfLine(match.snippet, location.start) : match.loc };
}

const byTypeByOptions = new WeakMap<ResolvedOptions, Map<string, JevRule[]>>();

function nodeTypeIndex(options: ResolvedOptions): Map<string, JevRule[]> {
  const cached = byTypeByOptions.get(options);
  if (cached !== undefined) return cached;
  const byType = rulesByNodeType(options.rules);
  byTypeByOptions.set(options, byType);
  return byType;
}

interface FilePass {
  readonly options: ResolvedOptions;
  readonly apiKey: string;
  readonly byType: Map<string, JevRule[]>;
  readonly matches: Match[];
  dropped: number;
}

function createOnce(context: Context): VisitorWithHooks {
  let pass: FilePass | null = null;

  const collect = (type: string, node: ESTree.Node): void => {
    if (pass === null) return;
    const rules = pass.byType.get(type);
    if (rules === undefined) return;
    for (const rule of rules) {
      if (pass.matches.length >= pass.options.maxMatchesPerFile) {
        pass.dropped += 1;
        return;
      }
      const own = snippetOf(context.sourceCode, node);
      const named = snippetNodeFor(node);
      const text = named === node ? own : context.sourceCode.getText(named);
      pass.matches.push({
        rule,
        loc: REPORT_LOC[rule.target](node, own),
        snippet: truncateSnippet(text, pass.options.maxSnippetChars),
        truncated: text.length > pass.options.maxSnippetChars,
      });
    }
  };

  const visitors: VisitorWithHooks = {};
  for (const type of Object.values(TARGET_NODE_TYPES).flat()) {
    visitors[type] = (node) => collect(type, node);
  }

  // `Program` carries the per-file setup as well as the `file` target, because oxlint does not
  // guarantee `before` runs for every file.
  visitors.Program = (node) => {
    const options = optionsFor(context.options[0]);
    const apiKey = (process.env[ENV.apiKey] ?? '').trim();
    if (apiKey.length === 0) {
      pass = null;
      if (process.env.CI && options.ci === 'fail') {
        if (missingKeyRaised) return;
        missingKeyRaised = true;
        throw new Error('oxlint-plugin-jev: TYPESAFE_API_KEY is not set');
      }
      warnOnce('missing-key', 'TYPESAFE_API_KEY is not set, skipping Jev checks');
      return;
    }
    pass = { options, apiKey, byType: nodeTypeIndex(options), matches: [], dropped: 0 };
    collect('Program', node);
  };

  visitors['Program:exit'] = () => {
    const collected = pass;
    pass = null;
    if (collected === null || collected.matches.length === 0) return;
    if (collected.dropped > 0) {
      const cap = collected.options.maxMatchesPerFile;
      const total = collected.matches.length + collected.dropped;
      warnOnce(
        `capped:${context.filename}`,
        `${total} matches exceeded maxMatchesPerFile=${cap}, ${collected.dropped} not checked (${context.filename})`,
      );
    }
    const deadline = Date.now() + collected.options.timeoutMs;
    const request = buildRequest(collected.options.model, collected.matches);
    const verdicts = verdictsFor(
      context,
      collected.options,
      collected.matches,
      collected.apiKey,
      request,
    );
    if (verdicts === null) return;
    let failure: { id: string; loc: Location; reason: string } | null = null;
    for (const [index, match] of collected.matches.entries()) {
      const score = verdicts.scores[refAt(index)];
      if (score >= match.rule.cutoff) {
        const { id, cutoff, question } = match.rule;
        // Avoid further requests after a failed refinement while preserving every confirmed finding.
        const located: LocatedResult =
          failure === null
            ? locateMatch(
                collected.options,
                match,
                index,
                verdicts,
                request,
                collected.apiKey,
                deadline,
              )
            : { loc: match.loc };
        if (located.failure !== undefined)
          failure = { id, loc: match.loc, reason: located.failure };
        context.report({
          loc: located.loc,
          messageId: 'yes',
          data: {
            id,
            model: verdicts.model,
            score: score.toFixed(2),
            cutoff: cutoff.toFixed(2),
            question,
          },
        });
      }
    }
    if (failure === null) return;
    // Throwing here would discard findings already reported for this file, so fail mode
    // emits the inference error as a separate diagnostic; skip mode warns as usual.
    if (process.env.CI && collected.options.ci === 'fail') {
      context.report({
        loc: failure.loc,
        messageId: 'unlocated',
        data: { id: failure.id, reason: failure.reason },
      });
    } else {
      warnOnce(failure.reason, `${failure.reason} (${context.filename})`);
    }
  };
  return visitors;
}

const meta = {
  type: 'problem',
  docs: {
    description:
      "Ask TypeSafe Jev a plain-English yes/no question about matched code and report when the yes-probability clears the rule's cutoff.",
  },
  schema: [SCHEMA],
  defaultOptions: [DEFAULTS],
  messages: {
    yes: '[{{id}}] {{model}} answered yes ({{score}} >= {{cutoff}}): {{question}}',
    unlocated:
      'oxlint-plugin-jev: {{reason}} while refining the location of [{{id}}]; the finding is reported at the file level',
  },
} satisfies RuleMeta;

const plugin: JevPlugin = {
  meta: { name: 'jev' },
  rules: { ask: { meta, createOnce } },
} satisfies Plugin;

export default plugin;
