// Operator-pause classifier for marketplace detail pages.
//
// A loop's item snapshots carry no structured "asks the operator at this step"
// flag, and the DoD for the marketplace bet forbids fabrication. So the detail
// page derives its "asks you" pills and "What it will ask you for" rows from
// the *real* agent system prompt, matching only high-precision gate phrases —
// the distinct wording agents actually use to mean "pause and let the operator
// decide" (audited against the published Build & Ship loop's agents).
//
// The classifier is intentionally narrow: generic mentions of "approval" in
// passing (e.g. "no human approval needed", "waits for the Code Reviewer")
// must NOT trip it, or the pill loses meaning. Only phrases that unambiguously
// say the agent stops and the human signs off qualify.

export interface OperatorAsk {
	/** Short categorical label for what the operator is asked to give. */
	ask: string
	/** Verbatim source excerpt around the gate phrase — the visible "why". */
	reason: string
}

// Ordered most-specific first so the tightest match wins. Every `re` is
// high-precision: it states an operator gate, not a passing mention.
const GATES: { re: RegExp; ask: string }[] = [
	{
		// "send only on explicit user signoff", "requires explicit user signoff"
		re: /(?:send|post|submit) (?:it )?only (?:on|with) (?:an )?explicit (?:user )?sign-?off|requires? (?:an )?explicit (?:user )?sign-?off/i,
		ask: 'your explicit sign-off',
	},
	{
		// "never auto-applies", "do not auto-apply", "Never auto-create … without…"
		re: /never auto-?appl(y|ies)|do not auto-?apply|never auto-(create|graduate|promote)/i,
		ask: 'an explicit go-ahead',
	},
	{
		// "for human sign-off", "waits for a human to approve", "awaiting human approval"
		re: /for (?:human|a human|the operator) sign-?off|for a human to (approve|decide)|awaiting (?:your|human|a human|the operator's?) (?:approval|decision|go-?ahead)/i,
		ask: 'your approval',
	},
	{
		// "awaits your approval", "waits for your / the operator's approval / go-ahead"
		re: /(?:awaits?|waits? for) (?:your|a human|the operator)'?s? (?:approval|decision|go-?ahead|sign-?off)/i,
		ask: 'your approval',
	},
	{
		// "requires your approval", "needs the operator's OK", "needs your go-ahead"
		re: /(?:requires?|needs?) (?:your|the operator's?|a human's?) (approval|confirmation|sign-?off|input|decision|go-?ahead|ok\b)/i,
		ask: 'your approval',
	},
	{
		// "without your approval", "without a human approval" — the negation of auto
		re: /without (?:your|a human|the operator's?) (?:approval|sign-?off|go-?ahead|decision)/i,
		ask: 'your approval',
	},
	{
		// passive gates: "(approval|sign-off|go-ahead) is required"
		re: /(?:approval|sign-?off|go-?ahead|confirmation) (?:is|are) required/i,
		ask: 'your approval',
	},
	{
		// "asks you to confirm", "asks the human to call it"
		re: /asks? (?:you|the human) (?:to|for)/i,
		ask: 'a decision from you',
	},
]

const CONTEXT_CHARS = 120

function excerpt(prompt: string, index: number, length: number): string {
	const start = Math.max(0, index - CONTEXT_CHARS)
	const end = Math.min(prompt.length, index + length + CONTEXT_CHARS)
	const around = prompt.slice(start, end).replace(/\s+/g, ' ').trim()
	const lead = start > 0 ? '…' : ''
	const trail = end < prompt.length ? '…' : ''
	return `${lead}${around}${trail}`
}

/** Returns the operator ask a step pauses for, or `null` when the prompt's
 * automation of that step does not hand control back to the operator. */
export function stepAsksYou(systemPrompt: string): OperatorAsk | null {
	const prompt = (systemPrompt ?? '').trim()
	if (!prompt) return null

	for (const { re, ask } of GATES) {
		const match = re.exec(prompt)
		if (match) {
			return { ask, reason: excerpt(prompt, match.index, match[0].length) }
		}
	}
	return null
}
