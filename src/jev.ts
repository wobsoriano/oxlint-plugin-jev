import { createHash } from 'node:crypto';
import type { Location } from '@oxlint/plugins';
import type { ChoiceQuestion } from '@typesafe-ai/sdk';
import type { ChoiceQuestions, JevRequest, JevRule, RequestMatch, Verdicts } from './types.ts';

export const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export const refAt = (index: number): string => `s${index}`;

export function truncateSnippet(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}/* ...truncated */`;
}

const sourceLines = (text: string): string[] => text.split(/\r\n|[\n\r\u2028\u2029]/);

type LocatedMatch = RequestMatch & {
  rule: { question: string; location: NonNullable<JevRule['location']> };
};

// A truncated snippet has incomplete lines and a synthetic marker, so it cannot be located.
export function locates(match: RequestMatch): match is LocatedMatch {
  return Boolean(match.rule.location) && !match.truncated;
}

interface LineRange {
  start: number;
  end: number;
}

export function locationCandidates(snippet: string, within?: LineRange): Record<string, LineRange> {
  const lines = sourceLines(snippet)
    .map((text, index) => ({ text, line: index + 1 }))
    .filter(
      ({ text, line }) => text.trim() && (!within || (line >= within.start && line <= within.end)),
    );
  const candidates: Record<string, LineRange> = {};
  // Reserve one of Choice's 255 options for an uncertain or inapplicable location.
  const width = Math.max(1, Math.ceil(lines.length / 254));
  for (let offset = 0; offset < lines.length; offset += width) {
    const start = lines[offset].line;
    const end = lines[Math.min(offset + width - 1, lines.length - 1)].line;
    candidates[start === end ? `L${start}` : `L${start}-L${end}`] = { start, end };
  }
  return candidates;
}

export function locationQuestion(
  match: LocatedMatch,
  ref: string,
  candidates: Record<string, LineRange>,
): ChoiceQuestion {
  return {
    type: 'choice',
    instructions: `Consider only the numbered source in state.snippets.${ref}. If it violates this rule, select the line (or range containing that line) to annotate. Rule: ${match.rule.question} Location: ${match.rule.location.question} If multiple violations exist, select the earliest one. Select unknown if no violation exists or its location is unclear.`,
    criteria: {
      ...Object.fromEntries(Object.keys(candidates).map((key) => [key, null])),
      unknown: 'No clear source location for this violation',
    },
  };
}

interface ChoiceAnswer {
  type: 'choice';
  choice: string;
  probabilities: Record<string, number>;
}

function isChoiceAnswer(
  answer: unknown,
  criteria: Record<string, unknown>,
): answer is ChoiceAnswer {
  if (
    typeof answer !== 'object' ||
    answer === null ||
    !('type' in answer) ||
    answer.type !== 'choice'
  )
    return false;
  if (
    !('choice' in answer) ||
    typeof answer.choice !== 'string' ||
    !Object.hasOwn(criteria, answer.choice)
  )
    return false;
  if (
    !('probabilities' in answer) ||
    typeof answer.probabilities !== 'object' ||
    answer.probabilities === null
  )
    return false;
  const probability = (answer.probabilities as Record<string, unknown>)[answer.choice];
  return typeof probability === 'number' && probability >= 0 && probability <= 1;
}

export function selectedLocation(
  answer: unknown,
  candidates: Record<string, LineRange>,
  cutoff: number,
): LineRange | null {
  if (
    !isChoiceAnswer(answer, { ...candidates, unknown: null }) ||
    !Object.hasOwn(candidates, answer.choice)
  )
    return null;
  return answer.probabilities[answer.choice] >= cutoff ? candidates[answer.choice] : null;
}

export function locationOfLine(snippet: string, line: number): Location {
  const text = sourceLines(snippet)[line - 1];
  return {
    start: { line, column: text.search(/\S/) },
    end: { line, column: text.trimEnd().length },
  };
}

export function buildRequest(model: string, matches: readonly RequestMatch[]): JevRequest {
  const snippets: Record<string, string> = {};
  const questions: JevRequest['questions'] = {};
  matches.forEach((match, index) => {
    const ref = refAt(index);
    snippets[ref] = locates(match)
      ? sourceLines(match.snippet)
          .map((text, index) => `L${index + 1}| ${text}`)
          .join('\n')
      : match.snippet;
    questions[ref] = {
      type: 'noul',
      instructions: `Consider only snippet "${ref}" in state.snippets. ${match.rule.question}`,
    };
    if (locates(match)) {
      questions[`${ref}_location`] = locationQuestion(
        match,
        ref,
        locationCandidates(match.snippet),
      );
    }
  });
  return { model, state: { snippets }, questions };
}

function answersOf(json: unknown): Record<string, unknown> {
  if (typeof json === 'object' && json !== null && 'answers' in json) {
    const { answers } = json;
    if (typeof answers === 'object' && answers !== null && !Array.isArray(answers)) {
      return answers as Record<string, unknown>;
    }
  }
  throw new Error('response has no answers object');
}

function modelOf(json: unknown): string {
  if (typeof json === 'object' && json !== null && 'model' in json) {
    const { model } = json;
    if (typeof model === 'string' && model.length > 0) return model;
  }
  throw new Error('response has no model id');
}

const noulOf = (answer: unknown): unknown =>
  typeof answer === 'object' && answer !== null && 'noul' in answer ? answer.noul : undefined;

export function choiceQuestionsOf(request: JevRequest): ChoiceQuestions {
  return Object.fromEntries(
    Object.entries(request.questions)
      .filter((entry): entry is [string, ChoiceQuestion] => entry[1].type === 'choice')
      .map(([id, question]) => [id, question.criteria]),
  );
}

export function parseVerdicts(
  json: unknown,
  refs: readonly string[],
  choices: ChoiceQuestions = {},
): Verdicts {
  const model = modelOf(json);
  const answers = answersOf(json);
  const scores: Record<string, number> = {};
  for (const ref of refs) {
    const noul = noulOf(answers[ref]);
    if (typeof noul !== 'number' || !(noul >= 0 && noul <= 1)) {
      throw new Error(`response has no probability in [0, 1] for "${ref}"`);
    }
    scores[ref] = noul;
  }
  // Malformed locations do not invalidate violation scores, but must be retried instead of cached.
  const complete = Object.entries(choices).every(([id, criteria]) =>
    isChoiceAnswer(answers[id], criteria),
  );
  return { model, scores, answers, complete };
}

export function cacheKey({ endpoint, request }: { endpoint: string; request: JevRequest }): string {
  const payload = JSON.stringify({ v: 3, endpoint, request });
  return createHash('sha256').update(payload).digest('hex');
}
