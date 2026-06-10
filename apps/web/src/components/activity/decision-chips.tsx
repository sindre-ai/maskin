import { Input } from '@/components/ui/input'
import { useCreateComment } from '@/hooks/use-events'
import type { EventResponse } from '@/lib/api'
import { cn } from '@/lib/cn'
import { useState } from 'react'

function extractChips(event: EventResponse): string[] {
	const metadata = event.data?.metadata as Record<string, unknown> | undefined
	const rawChips = metadata?.chips
	if (!Array.isArray(rawChips)) return []
	return rawChips
		.filter((c): c is string => typeof c === 'string' && c.length > 0)
		.slice(0, 5)
		.map((c) => (c.length > 20 ? c.slice(0, 20) : c))
}

export function hasDecisionChips(event: EventResponse): boolean {
	if (event.action !== 'commented') return false
	return extractChips(event).length > 0
}

interface DecisionChipsProps {
	event: EventResponse
	objectId: string
	workspaceId: string
}

export function DecisionChips({ event, objectId, workspaceId }: DecisionChipsProps) {
	const [dismissed, setDismissed] = useState(false)
	const [freeText, setFreeText] = useState('')
	const createComment = useCreateComment(workspaceId, objectId)

	const chips = extractChips(event)
	if (dismissed || chips.length === 0) return null

	const sendReply = (content: string) => {
		if (!content.trim() || createComment.isPending) return
		createComment.mutate(
			{
				entity_id: objectId,
				content: content.trim(),
				parent_event_id: event.id,
			},
			{ onSuccess: () => setDismissed(true) },
		)
	}

	return (
		<div className="flex flex-col gap-1.5">
			<div className="flex flex-wrap gap-1.5">
				{chips.map((chip, idx) => (
					<button
						key={`${chip}-${idx}`}
						type="button"
						onClick={() => sendReply(chip)}
						disabled={createComment.isPending}
						className={cn(
							'inline-flex items-center rounded-full border border-border',
							'px-2.5 py-0.5 text-xs font-medium text-foreground',
							'bg-transparent hover:bg-accent hover:text-accent-foreground',
							'transition-colors disabled:opacity-50 disabled:cursor-not-allowed',
						)}
					>
						{chip}
					</button>
				))}
			</div>
			<form
				onSubmit={(e) => {
					e.preventDefault()
					sendReply(freeText)
					setFreeText('')
				}}
				className="flex gap-1.5"
			>
				<Input
					value={freeText}
					onChange={(e) => setFreeText(e.target.value)}
					placeholder="Or type a reply…"
					disabled={createComment.isPending}
					className="flex-1 min-w-0 h-auto py-1 text-xs"
				/>
				<button
					type="submit"
					disabled={createComment.isPending || !freeText.trim()}
					aria-label="Send reply"
					className={cn(
						'inline-flex items-center justify-center rounded-md',
						'border border-border bg-transparent px-2.5 py-1',
						'text-xs text-foreground hover:bg-accent',
						'transition-colors disabled:opacity-50 disabled:cursor-not-allowed',
					)}
				>
					Send
				</button>
			</form>
		</div>
	)
}
