/**
 * Pre-v2 loop-summary, restored verbatim from before the v2 Loops/Triggers redesign.
 * Rendered when the `new-design` flag is OFF; the v2 replacement lives one
 * directory up. This whole directory dies with that flag
 * (`.claude/rules/feature-flags.md`).
 */
import type { LoopSummary as LoopSummaryType } from '@/lib/api'

// The "read it in four sentences" contract at the top of loop detail. Each
// sentence is built purely from real loop data (content, entry/close
// conditions, live counts) with conservative fallbacks so an under-specified
// loop still reads cleanly and always produces exactly four sentences.
export function buildLoopSummarySentences(loop: LoopSummaryType): string[] {
	const sentences: string[] = []

	const content = loop.content?.trim()
	sentences.push(
		content && content.length > 0
			? content
			: `${loop.name ?? 'This loop'} keeps the workspace moving on its own.`,
	)

	const entry = loop.entryCondition?.trim()
	sentences.push(
		entry && entry.length > 0
			? `New work enters when ${lowerFirst(entry)}.`
			: 'It picks up new work as it arrives.',
	)

	const close = loop.closeCondition?.trim()
	sentences.push(
		close && close.length > 0
			? `A cycle closes when ${lowerFirst(close)}.`
			: 'Cycles close once their work is done.',
	)

	if (loop.pill === 'waiting_on_you') {
		sentences.push('Right now it is waiting on you.')
	} else if (loop.pill === 'draft') {
		sentences.push('Right now it is a draft — not live yet.')
	} else if (loop.pill === 'paused') {
		sentences.push('Right now it is paused.')
	} else if (loop.inProgressCount > 0) {
		const n = loop.inProgressCount
		sentences.push(`Right now ${n} item${n === 1 ? ' is' : 's are'} in progress.`)
	} else if (loop.closedCount > 0) {
		const n = loop.closedCount
		sentences.push(`Right now ${n} item${n === 1 ? ' has' : 's have'} been completed.`)
	} else {
		sentences.push('Right now it is idle, waiting for new work.')
	}

	return sentences
}

function lowerFirst(s: string): string {
	return s.length === 0 ? s : (s[0] as string).toLowerCase() + s.slice(1)
}

export function LoopSummary({ loop }: { loop: LoopSummaryType }) {
	const sentences = buildLoopSummarySentences(loop)
	return (
		<section className="rounded-xl border border-border bg-card p-4">
			<div className="space-y-1.5" data-testid="loop-summary">
				{sentences.map((sentence) => (
					<p key={sentence} className="text-sm leading-relaxed text-foreground">
						{sentence}
					</p>
				))}
			</div>
		</section>
	)
}
