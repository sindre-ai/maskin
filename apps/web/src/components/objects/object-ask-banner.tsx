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

export function ObjectAskBanner({
	question,
	onAnswerClick,
	actorName,
	actorId,
	actorType,
}: ObjectAskBannerProps) {
	return (
		<div className="mb-6 flex flex-wrap items-center gap-3 rounded-xl border border-ask-border bg-ask-surface p-3">
			{actorName && (
				<ActorAvatar
					id={actorId}
					name={actorName}
					type={actorType ?? 'agent'}
					size="md"
					className="shrink-0"
				/>
			)}
			<div className="min-w-0 flex-1">
				<p className="text-[12.5px] font-bold text-warning">
					{actorName ? `${actorName} asks` : 'Open question'}
				</p>
				<p className="mt-0.5 truncate text-[11.5px] text-warning/90">{question}</p>
			</div>
			<Button size="sm" onClick={onAnswerClick} className="shrink-0" data-ask-answer>
				Answer it
				<ArrowDown size={14} />
			</Button>
		</div>
	)
}
