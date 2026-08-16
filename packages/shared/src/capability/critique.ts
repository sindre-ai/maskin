export interface SystemPromptCritique {
	/** Character length of the prompt (0 for null/empty). */
	length: number
	/** Count of markdown-style headings (`#`, `##`, `###`). */
	headingCount: number
	/** True if the prompt contains at least one concrete example marker. */
	hasExamples: boolean
	/** True if the prompt describes a decision procedure (steps / rules). */
	hasDecisionFramework: boolean
	/** True if the prompt states a stance / opinionation up front. */
	hasStance: boolean
	/** True if the prompt names an output format / shape. */
	hasOutputFormat: boolean
	/** True if the prompt is entirely empty or whitespace. */
	isEmpty: boolean
}

const HEADING_LINE_RE = /^\s{0,3}#{1,6}\s+\S/gm

// Markers of concrete examples. Includes markdown headers ("## Example"),
// inline cues ("for example", "e.g."), and code fences (```). Fenced blocks
// are strong evidence the prompt shows a shape rather than describing it.
const EXAMPLE_RE = /(?:^|[\s(])(?:examples?\s*[:\-—]|for example[,:\s]|e\.g\.)|```/i

// Signals a stepwise decision procedure: numbered lists like "1. ...",
// or explicit "When triggered" / "Steps" / "Method" cues.
const DECISION_FRAMEWORK_RE =
	/^\s*(\d+\.\s+\S|- (?:step|when |if )|when triggered|methodology|method\b|decision framework|process:)/im

// Explicit stance / opinionation cues used across the seed agent roster.
const STANCE_RE =
	/(you are (?:the |a |an )?\w+|opinionated|be pragmatic|do not|never |always |your (?:job|role) is)/i

// Output shape cues.
const OUTPUT_FORMAT_RE =
	/(output format|response format|return (?:a |the )?\w+|respond with|reply with|format:|schema:)/i

/**
 * Deterministic, LLM-free critique of a system prompt. Returns structural
 * signals used by the Expertise dimension of the capability score. Never
 * throws — an unusable prompt returns `isEmpty: true` with zeroed counts.
 */
export function critiqueSystemPrompt(draft: string | null | undefined): SystemPromptCritique {
	const text = typeof draft === 'string' ? draft : ''
	const trimmed = text.trim()
	if (trimmed.length === 0) {
		return {
			length: 0,
			headingCount: 0,
			hasExamples: false,
			hasDecisionFramework: false,
			hasStance: false,
			hasOutputFormat: false,
			isEmpty: true,
		}
	}
	const headingMatches = text.match(HEADING_LINE_RE)
	return {
		length: text.length,
		headingCount: headingMatches ? headingMatches.length : 0,
		hasExamples: EXAMPLE_RE.test(text),
		hasDecisionFramework: DECISION_FRAMEWORK_RE.test(text),
		hasStance: STANCE_RE.test(text),
		hasOutputFormat: OUTPUT_FORMAT_RE.test(text),
		isEmpty: false,
	}
}

/**
 * Map a critique to a 0–5 expertise dimension score. Public so the scorer
 * can apply the rubric in one place — same signals, single source of truth.
 */
export function expertiseScoreFromCritique(critique: SystemPromptCritique): number {
	if (critique.isEmpty) return 0
	if (critique.length < 200) return 1
	if (critique.length < 800 || critique.headingCount < 3) return 2
	const structured = critique.headingCount >= 3
	const hasFramework = critique.hasDecisionFramework || critique.hasStance
	if (structured && hasFramework && critique.hasExamples && critique.length >= 2000) return 5
	if (structured && hasFramework) return 4
	return 3
}
