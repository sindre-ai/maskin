import { ObjectPreviewMeta } from '@/components/shared/object-preview-meta'
import type { LatestMentionDecisionDraft } from '@/lib/api'

interface DraftPreviewProps {
	draft: LatestMentionDecisionDraft
}

/**
 * The message an agent proposes to send, shown above the decision buttons so the
 * reader sees exactly what Send would send. Always the whole message, never folded:
 * approving text you could not read in full is not approving it. Read only: changing it
 * is the For You draft-edit bet's job. Renders nothing without text, so a draft the feed could not
 * fill never shows as an empty box.
 */
export function DraftPreview({ draft }: DraftPreviewProps) {
	const body = draft.body?.trim()
	if (!body) return null

	return (
		<section
			aria-label={draft.label ?? 'Draft'}
			className="flex max-w-[58ch] flex-col gap-1.5 rounded-lg border border-border bg-muted/40 px-3 py-2.5"
		>
			<div className="flex items-baseline gap-2">
				<span className="eyebrow shrink-0">{draft.label ?? 'Draft'}</span>
				{draft.to && !draft.preview ? (
					<span className="min-w-0 truncate text-[12px] text-muted-foreground">To {draft.to}</span>
				) : null}
			</div>
			{draft.preview ? <ObjectPreviewMeta preview={draft.preview} /> : null}
			<p className="whitespace-pre-wrap text-[13px] leading-[1.55] text-foreground">{body}</p>
		</section>
	)
}
