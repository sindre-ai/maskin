import { FilePreview } from '@/components/shared/file-preview'
import { ObjectPreviewMeta } from '@/components/shared/object-preview-meta'
import { Textarea } from '@/components/ui/textarea'
import { useFeatureFlag } from '@/hooks/use-feature-flag'
import { useObject } from '@/hooks/use-objects'
import type { LatestMentionDecisionDraft } from '@/lib/api'
import {
	clearDraftEdit,
	getDraftChange,
	getDraftEdit,
	setDraftEdit,
	spliceDraftText,
	subscribeDraftEdits,
} from '@/lib/foryou-draft-edits'
import { queryKeys } from '@/lib/query-keys'
import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useSyncExternalStore } from 'react'

interface DraftPreviewProps {
	workspaceId: string
	draft: LatestMentionDecisionDraft
}

/**
 * The message an agent proposes to send, shown above the decision buttons so the
 * reader sees exactly what Send would send. Always the whole message, never folded:
 * approving text you could not read in full is not approving it. With the draft-edit flag on,
 * the text is a box the person can change where it stands; the change is saved and approved
 * when they take the sending option (see `saveDraftEdit`). Renders nothing without text, so a
 * draft the feed could not fill never shows as an empty box.
 *
 * A card about a file (an HTML page, a document, a picture) shows the file itself, open, in
 * the same place: the reader decides on what the file looks like, not on its name.
 */
export function DraftPreview({ workspaceId, draft }: DraftPreviewProps) {
	const canEdit = useFeatureFlag('foryou-draft-edit')
	if (draft.file) {
		return (
			<FilePreview
				workspaceId={workspaceId}
				fileId={draft.file.id}
				meta={{
					name: draft.file.name,
					mimeType: draft.file.mime_type,
					sizeBytes: draft.file.size_bytes,
				}}
				defaultExpanded
				className="mt-0"
			/>
		)
	}

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
			{canEdit && draft.object_id ? (
				<EditableDraftText workspaceId={workspaceId} objectId={draft.object_id} fallback={body} />
			) : (
				<DraftText text={body} />
			)}
		</section>
	)
}

function DraftText({ text }: { text: string }) {
	return <p className="whitespace-pre-wrap text-[13px] leading-[1.55] text-foreground">{text}</p>
}

/**
 * The draft's text as a box. It shows what the object says now, so an agent's later edit
 * appears without a reload, and holds the person's own change until they send. A draft whose
 * object cannot be read, or whose message cannot be told from the rest of its text, stays the
 * plain read-only text.
 */
function EditableDraftText({
	workspaceId,
	objectId,
	fallback,
}: {
	workspaceId: string
	objectId: string
	fallback: string
}) {
	const { data: object } = useObject(objectId)
	const edit = useSyncExternalStore(
		subscribeDraftEdits,
		() => getDraftEdit(objectId),
		() => undefined,
	)
	const changedTo = useSyncExternalStore(
		subscribeDraftEdits,
		() => getDraftChange(objectId),
		() => undefined,
	)
	// A draft that changed under the person: the text the save found is shown at once, and the
	// object is read again so the card follows it from then on.
	const queryClient = useQueryClient()
	useEffect(() => {
		if (changedTo === undefined) return
		queryClient.invalidateQueries({ queryKey: queryKeys.objects.detail(objectId) })
	}, [changedTo, objectId, queryClient])
	const content = object?.content ?? ''
	const shown = (object?.preview?.body ?? content).trim()
	if (!object || object.workspaceId !== workspaceId || !shown) {
		return <DraftText text={fallback} />
	}
	if (spliceDraftText(content, shown, shown) === null) return <DraftText text={shown} />

	return (
		<div className="flex flex-col gap-1.5">
			{changedTo !== undefined ? (
				<p role="alert" className="text-xs text-destructive">
					This draft changed while you were editing it. Here is the new text; nothing was sent.
				</p>
			) : null}
			<Textarea
				autoResize
				aria-label="Edit the text"
				value={edit ?? changedTo ?? shown}
				onChange={(event) => {
					const value = event.target.value
					if (value === shown) clearDraftEdit(objectId)
					else setDraftEdit(objectId, value)
				}}
				className="min-h-24 resize-none bg-background text-[13px] leading-[1.55]"
			/>
		</div>
	)
}
