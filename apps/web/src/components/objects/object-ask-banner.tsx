import { ActorAvatar } from '@/components/shared/actor-avatar'
import { Button } from '@/components/ui/button'
import { ArrowDown } from 'lucide-react'

interface ObjectAskBannerProps {
	question: string
	onAnswerClick: () => void
	/** The agent that asked. When known the banner leads with its avatar and
	 *  reads "<Agent> asks" (mockup 1097–1104). */
	actorName?: string
	actorId?: string
	actorType?: string
}

/**
 * The open ask, one line under the title (mockup 1097–1104): avatar, a bolded
 * lead ("<Agent> asks · ") running straight into the question on a single
 * truncated line, and the jump-to-answer button. It is a pointer to the ask
 * further down the timeline, not the ask itself — so it never wraps to two
 * lines and never grows past 26px of button.
 */
export function ObjectAskBanner({
	question,
	onAnswerClick,
	actorName,
	actorId,
	actorType,
}: ObjectAskBannerProps) {
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
			<p className="min-w-0 flex-1 truncate text-[11.5px] leading-[1.45] text-muted-foreground">
				<span className="font-bold text-foreground">
					{actorName ? `${actorName} asks` : 'Open question'} ·{' '}
				</span>
				{question}
			</p>
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
