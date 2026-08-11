import { Button } from '@/components/ui/button'
import { ArrowDown } from 'lucide-react'

/**
 * Amber call-out for the agent's open question, rendered between the header
 * and the body. "Answer it" moves focus down to the answer control (the
 * comment composer) without a page jump — the shell handles the scroll.
 */
export function ObjectAskBanner({
	title,
	sub,
	onAnswer,
}: {
	title: string
	sub: string | null
	onAnswer: () => void
}) {
	return (
		<div className="flex items-center gap-3 rounded-lg border border-warning/40 bg-warning/10 p-3">
			<div className="min-w-0 flex-1">
				<p className="text-sm font-bold text-foreground">{title}</p>
				{sub && (
					<p className="mt-0.5 truncate text-xs text-muted-foreground" title={sub}>
						{sub}
					</p>
				)}
			</div>
			<Button variant="default" size="sm" className="shrink-0" onClick={onAnswer}>
				Answer it
				<ArrowDown size={13} />
			</Button>
		</div>
	)
}
