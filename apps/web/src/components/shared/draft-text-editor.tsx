import { Textarea } from '@/components/ui/textarea'
import { useDraftChange, useDraftEdit } from '@/hooks/use-draft-editor'
import { useObject } from '@/hooks/use-objects'
import { clearDraftEdit, setDraftEdit, spliceDraftText } from '@/lib/draft-edits'
import { queryKeys } from '@/lib/query-keys'
import { useQueryClient } from '@tanstack/react-query'
import { type ReactNode, useEffect } from 'react'

interface DraftTextEditorProps {
	workspaceId: string
	objectId: string
	/** The text the card was handed, shown until the object has loaded. */
	fallback: string
	/** How the text reads when it cannot be edited here. */
	readOnly: (text: string) => ReactNode
	/** False draws the text read only. Defaults to true. */
	canEdit?: boolean
}

/**
 * A draft's text as a box, where the For You card and the chat card both let a person change
 * it before they approve. It shows what the object says now, so an agent's later edit appears
 * without a reload, and holds the person's own change (see `lib/draft-edits`) until they
 * approve, which saves it and approves the saved text. A draft whose object cannot be read, or
 * whose message cannot be told from the rest of its text, stays the read only text.
 */
export function DraftTextEditor({
	workspaceId,
	objectId,
	fallback,
	readOnly,
	canEdit = true,
}: DraftTextEditorProps) {
	const { data: object } = useObject(objectId)
	const edit = useDraftEdit(objectId)
	const changedTo = useDraftChange(objectId)
	// A draft that changed under the person: the text the save found is shown at once, and the
	// object is read again so the card follows it from then on.
	const queryClient = useQueryClient()
	useEffect(() => {
		if (changedTo === undefined) return
		queryClient.invalidateQueries({ queryKey: queryKeys.objects.detail(objectId) })
	}, [changedTo, objectId, queryClient])
	const content = object?.content ?? ''
	const shown = (object?.preview?.body ?? content).trim()
	if (!canEdit || !object || object.workspaceId !== workspaceId || !shown) {
		return <>{readOnly(fallback)}</>
	}
	if (spliceDraftText(content, shown, shown) === null) return <>{readOnly(shown)}</>

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
