import { Button } from '@/components/ui/button'
import type { LatestMentionDecisionDraft } from '@/lib/api'
import { useState } from 'react'

/** Past this many characters a draft folds to four lines until opened. */
const FOLD_AFTER = 240

interface DraftPreviewProps {
	draft: LatestMentionDecisionDraft
}

/**
 * The message an agent proposes to send, shown above the decision buttons so the
 * reader sees exactly what Send would send. Read only: changing it is the For You
 * draft-edit bet's job. Renders nothing without text, so a draft the feed could not
 * fill never shows as an empty box.
 */
export function DraftPreview({ draft }: DraftPreviewProps) {
	const [open, setOpen] = useState(false)
	const body = draft.body?.trim()
	if (!body) return null
	const folds = body.length > FOLD_AFTER || body.split('\n').length > 4

	return (
		<section
			aria-label={draft.label ?? 'Draft'}
			className="flex max-w-[58ch] flex-col gap-1.5 rounded-lg border border-border bg-muted/40 px-3 py-2.5"
		>
			<div className="flex items-baseline gap-2">
				<span className="eyebrow shrink-0">{draft.label ?? 'Draft'}</span>
				{draft.to ? (
					<span className="min-w-0 truncate text-[12px] text-muted-foreground">To {draft.to}</span>
				) : null}
			</div>
			<p
				className={`whitespace-pre-wrap text-[13px] leading-[1.55] text-foreground ${
					folds && !open ? 'line-clamp-4' : ''
				}`}
			>
				{body}
			</p>
			{folds ? (
				<Button
					type="button"
					variant="ghost"
					size="sm"
					className="-ml-2 h-7 self-start px-2 text-xs"
					onClick={() => setOpen((v) => !v)}
				>
					{open ? 'Show less' : 'Read all'}
				</Button>
			) : null}
		</section>
	)
}
