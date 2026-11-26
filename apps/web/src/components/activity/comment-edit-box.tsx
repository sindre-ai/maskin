import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { useEditComment } from '@/hooks/use-edit-comment'
import { useState } from 'react'

interface CommentEditBoxProps {
	workspaceId: string
	objectId: string
	eventId: number
	initialContent: string
	onDone: () => void
}

/** The comment's text as a box, with Save and Cancel, in place of the rendered message. */
export function CommentEditBox({
	workspaceId,
	objectId,
	eventId,
	initialContent,
	onDone,
}: CommentEditBoxProps) {
	const [text, setText] = useState(initialContent)
	const edit = useEditComment(workspaceId, objectId)
	const trimmed = text.trim()
	const unchanged = trimmed === initialContent.trim()

	const save = () => {
		if (!trimmed || edit.isPending) return
		if (unchanged) {
			onDone()
			return
		}
		edit.mutate({ eventId, content: trimmed }, { onSuccess: onDone })
	}

	return (
		<div className="mt-1 flex flex-col gap-1.5">
			<Textarea
				autoResize
				autoFocus
				aria-label="Edit your comment"
				value={text}
				onChange={(event) => setText(event.target.value)}
				onKeyDown={(event) => {
					if (event.key === 'Escape') onDone()
					if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) save()
				}}
				className="min-h-16 resize-none bg-background text-[13px] leading-[1.55]"
			/>
			<div className="flex justify-end gap-1.5">
				<Button type="button" variant="ghost" size="sm" onClick={onDone}>
					Cancel
				</Button>
				<Button type="button" size="sm" onClick={save} disabled={!trimmed || edit.isPending}>
					Save
				</Button>
			</div>
		</div>
	)
}
