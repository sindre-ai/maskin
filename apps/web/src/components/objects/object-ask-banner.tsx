import { Button } from '@/components/ui/button'
import { CornerDownLeft } from 'lucide-react'

interface ObjectAskBannerProps {
	question: string
	onAnswerClick: () => void
}

export function ObjectAskBanner({ question, onAnswerClick }: ObjectAskBannerProps) {
	return (
		<div className="mb-8 flex flex-col gap-3 rounded-md border border-border bg-bg-surface p-3 sm:flex-row sm:items-center sm:justify-between">
			<div className="min-w-0">
				<p className="text-[11px] font-medium uppercase text-muted-foreground">Open question</p>
				<p className="mt-0.5 text-sm text-foreground">{question}</p>
			</div>
			<Button
				variant="outline"
				size="sm"
				onClick={onAnswerClick}
				className="shrink-0 self-start sm:self-auto"
				data-ask-answer
			>
				Answer it
				<CornerDownLeft size={14} />
			</Button>
		</div>
	)
}
