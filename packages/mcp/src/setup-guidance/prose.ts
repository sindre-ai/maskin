import { sortByPriority } from './priority'
import type { SetupCheck } from './types'

function renderItems(checks: SetupCheck[], startAt: number): string[] {
	return checks.map((check, idx) => {
		const suffix = check.fix ? ` (fix: call ${check.fix.tool} — ${check.fix.args_hint})` : ''
		return `  ${startAt + idx}. ${check.message}${suffix}`
	})
}

/**
 * Render checks as prose for the calling LLM, split into two groups. `fail`
 * checks are real blockers (missing LLM key, a loop step with no agent) and
 * must be relayed to the user. `warn` checks are not blockers: the agent
 * fixes them itself with the listed tool when the answer is obvious,
 * otherwise mentions them as one FYI line in its final message. A warn item
 * never justifies ending the turn on a question.
 *
 * Numbered items, one gap per line, each with the fix hint attached.
 * Returns an empty string when there is nothing to report.
 */
export function toProseBlock(checks: SetupCheck[]): string {
	const sorted = sortByPriority(checks).filter((c) => c.status !== 'unknown')
	if (sorted.length === 0) return ''

	const blockers = sorted.filter((c) => c.status === 'fail')
	const others = sorted.filter((c) => c.status !== 'fail')

	const lines: string[] = []
	if (blockers.length > 0) {
		lines.push('Blockers — tell the user, this stops the work until it is resolved:')
		lines.push(...renderItems(blockers, 1))
	}
	if (others.length > 0) {
		lines.push(
			'Not blockers — fix these yourself with the listed tool if the answer is obvious, otherwise mention them as one FYI line in your final message. Never end your turn on a question about them:',
		)
		lines.push(...renderItems(others, blockers.length + 1))
	}
	return lines.join('\n')
}
