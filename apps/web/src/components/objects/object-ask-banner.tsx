import { ActorAvatar } from '@/components/shared/actor-avatar'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/cn'
import { ArrowDown, MessageCircleQuestion } from 'lucide-react'
import { useLayoutEffect, useRef, useState } from 'react'

interface ObjectAskBannerProps {
	question: string
	onAnswerClick: () => void
	/** The agent that asked. When known the banner leads with its avatar and
	 *  reads "<Agent> asks" (mockup 1097–1104). */
	actorName?: string
	actorId?: string
	actorType?: string
	/** `line` is the one slim line the item page draws under its meta row: "<Agent> asks:", the
	 *  question (two lines on a phone) and an Answer button. */
	variant?: 'card' | 'line'
}

/**
 * The open ask, one line under the title (mockup 1097–1104): avatar, a bolded
 * lead ("<Agent> asks · ") running straight into the question on a single
 * truncated line, and the jump-to-answer button. A question that does not fit
 * on the line gets a "Show all" toggle that expands it in place, so a long
 * welcome can be read without leaving the banner.
 */
export function ObjectAskBanner({
	question,
	onAnswerClick,
	actorName,
	actorId,
	actorType,
	variant = 'card',
}: ObjectAskBannerProps) {
	const textRef = useRef<HTMLParagraphElement>(null)
	const [expanded, setExpanded] = useState(false)
	const [overflows, setOverflows] = useState(false)

	// Measured while collapsed: the toggle only appears when the line is cut.
	// Re-measured on resize, since phone and desktop widths cut at different points.
	// biome-ignore lint/correctness/useExhaustiveDependencies: re-measure when the text changes.
	useLayoutEffect(() => {
		if (expanded) return
		const el = textRef.current
		if (!el) return
		const measure = () => setOverflows(el.scrollWidth > el.clientWidth)
		measure()
		window.addEventListener('resize', measure)
		return () => window.removeEventListener('resize', measure)
	}, [expanded, question, actorName])

	if (variant === 'line') {
		return (
			<div className="flex items-center gap-3 rounded-xl border border-ask-border bg-ask-surface px-3.5 py-2.5 text-[13.5px] text-foreground">
				<MessageCircleQuestion aria-hidden className="size-4 shrink-0 text-muted-foreground" />
				<p className="line-clamp-2 min-w-0 flex-1">
					<span className="font-semibold">
						{actorName ? `${actorName} asks:` : 'Open question:'}
					</span>{' '}
					<span className="text-muted-foreground">{question}</span>
				</p>
				<Button
					size="sm"
					onClick={onAnswerClick}
					className="h-7 shrink-0 rounded-lg px-3 text-[12px] font-semibold"
					data-ask-answer
				>
					Answer
				</Button>
			</div>
		)
	}

	return (
		<div className="mt-3.5 flex flex-wrap items-center gap-2 rounded-[11px] border border-ask-border bg-ask-surface px-[11px] py-[9px]">
			{actorName && (
				<ActorAvatar
					id={actorId}
					name={actorName}
					type={actorType ?? 'agent'}
					size="sm"
					className="size-5 shrink-0 text-[8.5px]"
				/>
			)}
			<p
				ref={textRef}
				className={cn(
					'min-w-0 flex-1 text-[11.5px] leading-[1.45] text-muted-foreground',
					expanded ? 'whitespace-pre-wrap break-words' : 'truncate',
				)}
			>
				<span className="font-bold text-foreground">
					{actorName ? `${actorName} asks` : 'Open question'} ·{' '}
				</span>
				{question}
			</p>
			{(overflows || expanded) && (
				<button
					type="button"
					onClick={() => setExpanded((v) => !v)}
					aria-expanded={expanded}
					className="shrink-0 text-[11.5px] font-semibold text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
				>
					{expanded ? 'Show less' : 'Show all'}
				</button>
			)}
			<Button
				size="sm"
				onClick={onAnswerClick}
				className="h-[26px] shrink-0 gap-1.5 rounded-lg px-[11px] text-[11.5px] font-semibold"
				data-ask-answer
			>
				Answer it
				<ArrowDown size={12} />
			</Button>
		</div>
	)
}
