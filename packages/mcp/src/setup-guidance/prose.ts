import { sortByPriority } from './priority'
import type { SetupCheck } from './types'

/**
 * Render checks as forceful, imperative prose the calling LLM should relay to
 * the user before it ends its turn. Deliberately matches `get_started`'s
 * "INSTRUCTIONS FOR THE ... section — render this BEFORE anything else" voice
 * rather than a quiet declarative sentence — a `setup` field is one key among
 * many in a JSON tool response, so the text itself has to carry the emphasis
 * a UI would otherwise provide (bolding, placement, a modal). Numbered items,
 * one gap per line, each with the fix hint attached.
 *
 * Returns an empty string when there is nothing to ask about.
 */
export function toProseBlock(checks: SetupCheck[]): string {
	const sorted = sortByPriority(checks).filter((c) => c.status !== 'unknown')
	if (sorted.length === 0) return ''

	const lines: string[] = [
		'IMPORTANT — before ending your turn, relay these setup gaps to the user (do not skip this silently):',
	]
	sorted.forEach((check, idx) => {
		const num = idx + 1
		const suffix = check.fix ? ` (fix: call ${check.fix.tool} — ${check.fix.args_hint})` : ''
		lines.push(`  ${num}. ${check.message}${suffix}`)
	})
	return lines.join('\n')
}
