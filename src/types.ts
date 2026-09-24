import type { Location, Range } from '@oxlint/plugins';
import type { ChoiceQuestion, NoulQuestion } from '@typesafe-ai/sdk';

export type Target = 'function' | 'call' | 'jsx' | 'file';

export type CiBehavior = 'skip' | 'fail';

export interface JevRule {
  /** Unique within the rule list. Shown in the lint message. */
  id: string;
  target: Target;
  /** One English yes/no question. "Yes" means "report an error". */
  question: string;
  /** Report when Jev's yes-probability is >= this. Between 0 and 1. */
  cutoff: number;
  /** File rules may select a source line, keeping a file-level finding below this probability. */
  location?: { question: string; cutoff: number };
}

export interface JevOptions {
  ci?: CiBehavior;
  timeoutMs?: number;
  maxMatchesPerFile?: number;
  maxSnippetChars?: number;
  model?: string;
  rules: JevRule[];
}

/** Options as a rule sees them, with `meta.defaultOptions` already merged underneath by oxlint. */
export type ResolvedOptions = Required<JevOptions>;

export interface RequestMatch {
  readonly rule: Pick<JevRule, 'question' | 'location'>;
  readonly snippet: string;
  readonly truncated?: boolean;
}

export interface Match extends RequestMatch {
  readonly rule: JevRule;
  readonly loc: Location;
}

export interface JevRequest {
  model: string;
  state: { snippets: Record<string, string> };
  questions: Record<string, NoulQuestion | ChoiceQuestion>;
}

export type ChoiceQuestions = Record<string, ChoiceQuestion['criteria']>;

export interface Verdicts {
  /** The versioned id that answered, such as `jev-1.13.0`, even when the request said `jev-latest`. */
  readonly model: string;
  readonly scores: Record<string, number>;
  readonly answers: Record<string, unknown>;
  /** Whether every requested Choice answer is valid and can be cached. */
  readonly complete: boolean;
}

export type VerdictResult = { ok: true; verdicts: Verdicts } | { ok: false; reason: string };

export interface AskInput {
  apiKey: string;
  baseURL: string;
  request: JevRequest;
  timeoutMs: number;
}

export type AskResult = { ok: true; json: unknown } | { ok: false; reason: string };

export interface SnippetNode {
  readonly type: string;
  readonly range: Range;
  readonly parent?: NamedParent | null | undefined;
}

export interface NamedParent extends SnippetNode {
  readonly init?: unknown;
  readonly value?: unknown;
}

export interface ReportNode {
  readonly loc: Location;
  readonly openingElement?: { readonly loc: Location } | undefined;
}

/** The public shape of the default export. Consumers load the plugin by name, so the rule
 * internals are deliberately not part of the published type. */
export interface JevPlugin {
  meta: { name: string };
  rules: { ask: object };
}
