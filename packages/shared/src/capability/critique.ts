import type { PromptCriterion } from './types'

// Deterministic producer-critic rubric over a system-prompt draft. Used two ways:
// as the fast pre-check before the LLM reviewer in the agent-builder pipeline, and
// as the input to the Expertise capability dimension. Each regex is a heuristic for
// a signal the seeded template agents (packages/shared/src/templates/) all carry —
// they are the calibration anchor, unit-tested to pass every criterion.

/** "You are the X" / "You are a Y" / "Act as" / "Your role is" — the prompt names an identity. */
const ROLE_RE = /\b(you are|act as|your role is|you're)\b/i

/** Scope limits: out-of-scope markers, "only", "never", "do not", explicit boundaries. */
const SCOPE_RE =
	/\b(scope|out of scope|only handle|do not|don't|never|must not|not your job|boundar)/i

/** Decision rules: when/if→then flows, priority ordering, explicit never/always/prefer rules. */
const DECISION_RE =
	/\b(when\s.+?,|if\s.+?,|then\b|priorit(y|ies|ize|ise)|prefer\b|always\b|never\b|first,|escalat)/i

/** Recommendation-forcing stance: commit to a position, state assumptions, no hedging. */
const STANCE_RE =
	/\b(recommend|opinionated|opinion|decisive|commit to|state (your )?assumptions|do not hedge|don't hedge|no hedging|take a (clear )?(stance|position))\b/i

/** Concrete examples: fenced blocks, Example sections/labels, ✅/❌ good-bad pairs. */
const EXAMPLES_RE = /```|^#{1,6}\s.*examples?\b|\bexample[:s]|[✅❌]/im

/** Output shape: format/template/structure instructions for what the agent produces. */
const OUTPUT_RE =
	/\b(outputs?|format|template|respond with|return|produce|deliverable|structure your)\b/i

const HEADING_RE = /^#{1,6}\s/gm
/** Bold-numbered step lists ("1. **Read the bet** — …") count as structure too. */
const NUMBERED_STEP_RE = /^\s*\d+\.\s/gm

export const PROMPT_MIN_LENGTH = 200
export const PROMPT_SOLID_LENGTH = 800
export const PROMPT_DEEP_LENGTH = 2000
export const PROMPT_MIN_HEADINGS = 3

export function critiqueSystemPrompt(draft: string): PromptCriterion[] {
	const text = draft ?? ''
	const headings = text.match(HEADING_RE)?.length ?? 0
	const numberedSteps = text.match(NUMBERED_STEP_RE)?.length ?? 0
	const sections = Math.max(headings, numberedSteps)

	return [
		criterion(
			'role_identity',
			ROLE_RE.test(text),
			'Names a clear role identity',
			'Open with a concrete identity — "You are the <role>" — grounded in specific expertise, not a generic assistant.',
		),
		criterion(
			'scope_boundaries',
			SCOPE_RE.test(text),
			'Defines scope boundaries',
			'State what is out of scope: what the agent must NOT do, and where its responsibility ends.',
		),
		criterion(
			'decision_framework',
			DECISION_RE.test(text),
			'Contains decision rules',
			'Add a decision framework: when/if→then rules, priority ordering, or explicit always/never/prefer rules the agent applies.',
		),
		criterion(
			'stance',
			STANCE_RE.test(text),
			'Forces a stance',
			'Add stance-forcing instructions: give a clear recommendation, state assumptions, do not hedge or enumerate options neutrally.',
		),
		criterion(
			'examples',
			EXAMPLES_RE.test(text),
			'Includes concrete examples',
			'Add 1–3 concrete worked examples (fenced blocks or ✅/❌ pairs) showing expected reasoning and output.',
		),
		criterion(
			'output_format',
			OUTPUT_RE.test(text),
			'Specifies output format',
			'Describe the expected output: what the agent produces and in what format or template.',
		),
		criterion(
			'structure',
			sections >= PROMPT_MIN_HEADINGS,
			`Structured with ${sections} sections`,
			`Organize the prompt into at least ${PROMPT_MIN_HEADINGS} markdown sections or numbered steps (role, scope, decision framework, output).`,
		),
		criterion(
			'length',
			text.length >= PROMPT_SOLID_LENGTH,
			`Substantial (${text.length} chars)`,
			`Expand the prompt to at least ${PROMPT_SOLID_LENGTH} characters — a real SME briefing, not a one-liner.`,
		),
	]
}

function criterion(
	id: PromptCriterion['id'],
	pass: boolean,
	passDetail: string,
	failDetail: string,
): PromptCriterion {
	return { id, pass, detail: pass ? passDetail : failDetail }
}
