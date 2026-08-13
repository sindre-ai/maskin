import type { LoopSummary as LoopSummaryType } from '@/lib/api'

// The "read it in four sentences" contract at the top of loop detail. Each
// sentence is built purely from real loop data (guarantee, entry/close
// conditions, live counts) with conservative fallbacks so an under-specified
// loop still reads cleanly and always produces exactly four sentences.
export function buildLoopSummarySentences(loop: LoopSummaryType): string[] {
	const sentences: string[] = []

	const guarantee = loop.guarantee?.trim()
	sentences.push(
		guarantee && guarantee.length > 0
			? guarantee
			: `${loop.name ?? 'This loop'} keeps the workspace moving on its own.`,
	)

	const entry = loop.entryCondition?.trim()
	sentences.push(
		entry && entry.length > 0
			? `New work enters when ${lowerFirst(entry)}.`
			: 'It picks up new work as it arrives.',
	)

	const close = loop.closeCondition?.trim()
	if (close && close.length > 0) {
		sentences.push(`A cycle closes when ${lowerFirst(close)}.`)
	} else if (loop.humanDecisionPoints && loop.humanDecisionPoints > 0) {
		const n = loop.humanDecisionPoints
		sentences.push(`It stops for you at ${n} decision point${n === 1 ? '' : 's'}.`)
	} else {
		sentences.push('Cycles close once their work is done.')
	}

	if (loop.pill === 'waiting_on_you') {
		const n = loop.humanDecisionPoints
		sentences.push(
			`Right now it is waiting on you${n && n > 0 ? `, with ${n} decision point${n === 1 ? '' : 's'} open` : ''}.`,
		)
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
