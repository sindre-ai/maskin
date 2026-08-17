import { sortByPriority } from './priority'
import type { SetupCheck } from './types'

/**
 * Render checks as the "Ask the user…" prose the calling LLM should read back
 * to the user. Voice matches `get_started` — numbered items, one gap per line,
 * each with the fix hint attached.
 *
 * Returns an empty string when there is nothing to ask about.
 */
export function toProseBlock(checks: SetupCheck[]): string {
	const sorted = sortByPriority(checks).filter((c) => c.status !== 'unknown')
	if (sorted.length === 0) return ''

	const lines: string[] = ['Ask the user:']
	sorted.forEach((check, idx) => {
		const num = idx + 1
		const suffix = check.fix ? ` (fix: call ${check.fix.tool} — ${check.fix.args_hint})` : ''
		lines.push(`  ${num}. ${check.message}${suffix}`)
	})
	return lines.join('\n')
}
