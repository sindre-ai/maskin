import type { LoopSummary as LoopSummaryType } from '@/lib/api'
import { cn } from '@/lib/cn'

/** One run of the summary story. `emphasis` marks the key noun the mockup
 *  renders at full ink and weight against the muted body (mockup 1865). */
export interface LoopSummarySegment {
	text: string
	emphasis?: boolean
}

export type LoopSummarySentence = LoopSummarySegment[]

const seg = (text: string): LoopSummarySegment => ({ text })
const em = (text: string): LoopSummarySegment => ({ text, emphasis: true })

/** Flatten a sentence back to plain text — used for keys and for anything that
 *  needs the reading rather than the rendering. */
export function loopSummarySentenceText(sentence: LoopSummarySentence): string {
	return sentence.map((s) => s.text).join('')
}

// The "read it in four sentences" contract at the top of loop detail. Each
// sentence is built purely from real loop data (guarantee, entry/close
// conditions, live counts) with conservative fallbacks so an under-specified
// loop still reads cleanly and always produces exactly four sentences.
export function buildLoopSummarySentences(loop: LoopSummaryType): LoopSummarySentence[] {
	const sentences: LoopSummarySentence[] = []

	// `content` is the loop's outcome line — the field #1396 renamed from
	// `guarantee`. It is the one sentence the list row shows too, so the story
	// opens on the same promise the operator scanned.
	const outcome = loop.content?.trim()
	sentences.push(
		outcome && outcome.length > 0
			? [em(outcome)]
			: [em(loop.name ?? 'This loop'), seg(' keeps the workspace moving on its own.')],
	)

	const entry = loop.entryCondition?.trim()
	sentences.push(
		entry && entry.length > 0
			? [seg('New work enters when '), em(lowerFirst(entry)), seg('.')]
			: [seg('It picks up new work as it arrives.')],
	)

	const close = loop.closeCondition?.trim()
	sentences.push(
		close && close.length > 0
			? [seg('A cycle closes when '), em(lowerFirst(close)), seg('.')]
			: [seg('Cycles close once their work is done.')],
	)

	if (loop.pill === 'waiting_on_you') {
		sentences.push([seg('Right now it is '), em('waiting on you'), seg('.')])
	} else if (loop.pill === 'paused') {
		sentences.push([seg('Right now it is '), em('paused'), seg('.')])
	} else if (loop.inProgressCount > 0) {
		const n = loop.inProgressCount
		sentences.push([
			seg('Right now '),
			em(`${n} item${n === 1 ? ' is' : 's are'} in progress`),
			seg('.'),
		])
	} else if (loop.closedCount > 0) {
		const n = loop.closedCount
		sentences.push([
			seg('Right now '),
			em(`${n} item${n === 1 ? ' has' : 's have'} been completed`),
			seg('.'),
		])
	} else {
		sentences.push([seg('Right now it is '), em('idle'), seg(', waiting for new work.')])
	}

	return sentences
}

function lowerFirst(s: string): string {
	return s.length === 0 ? s : (s[0] as string).toLowerCase() + s.slice(1)
}

export function LoopSummary({ loop }: { loop: LoopSummaryType }) {
	const sentences = buildLoopSummarySentences(loop)
	return (
		<section>
			<div className="text-[15px] leading-[1.75] text-muted-foreground" data-testid="loop-summary">
				{sentences.map((sentence) => (
					<p key={loopSummarySentenceText(sentence)}>
						{sentence.map((segment) => (
							<span
								key={segment.text}
								className={cn(segment.emphasis && 'font-semibold text-foreground')}
							>
								{segment.text}
							</span>
						))}
					</p>
				))}
			</div>
		</section>
	)
}
