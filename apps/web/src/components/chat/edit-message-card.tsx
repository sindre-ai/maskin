import { TagInput } from '@/components/chat/tag-input'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { cn } from '@/lib/cn'
import { type TagSegment, type TagValue, editSegments } from '@/lib/tag-input-model'
import { MESSAGE_MAX_LENGTH } from '@maskin/shared'
import { useCallback, useState } from 'react'

// The counter shows from here, so it does not nag on every short message.
const COUNTER_FROM = 7500

export interface EditMessageCardProps {
	workspaceId: string
	conversationParticipantIds: string[]
	selfActorId: string | null
	/** The stored text and tagged ids of the message being edited. */
	content: string
	mentions: string[]
	/** How a tagged id reads in the text ("Name"), or null when the actor is not known. */
	labelOf: (id: string) => string | null
	/** Whether a tagged id belongs to an agent, for the "will get this" notice. */
	agentName: (id: string) => string | null
	saving: boolean
	failed: boolean
	onSave: (value: TagValue) => void
	onCancel: () => void
}

/** The edit card that replaces the bubble while you edit your own message. */
export function EditMessageCard({
	workspaceId,
	conversationParticipantIds,
	selfActorId,
	content,
	mentions,
	labelOf,
	agentName,
	saving,
	failed,
	onSave,
	onCancel,
}: EditMessageCardProps) {
	// Opening the card fixes its starting content. Tags that sat outside an old message's text
	// come in as chips at the start.
	const [initialSegments] = useState<TagSegment[]>(() => editSegments(content, mentions, labelOf))
	const [initial] = useState<TagValue>(() => ({
		text: initialSegments.map((s) => (s.kind === 'chip' ? `@${s.label}` : s.text)).join(''),
		ids: initialSegments.flatMap((s) => (s.kind === 'chip' ? [s.id] : [])),
	}))
	const [value, setValue] = useState<TagValue>(initial)
	const handleChange = useCallback((next: TagValue) => setValue(next), [])

	const length = value.text.trim().length
	const over = length > MESSAGE_MAX_LENGTH
	const changed = value.text !== initial.text || value.ids.join() !== initial.ids.join()
	const canSave = changed && length > 0 && !over && !saving

	// Agents added since the message was sent get woken on save; say so before they are.
	const added = value.ids.filter((id) => !mentions.includes(id))
	const notified = added.flatMap((id) => {
		const name = agentName(id)
		return name ? [name] : []
	})

	const save = () => {
		if (canSave) onSave(value)
	}

	return (
		<div className="flex flex-col gap-1.5">
			<div
				className={cn(
					'@container relative flex flex-col rounded-xl border bg-card text-card-foreground shadow-sm',
					'transition-[border-color,box-shadow] duration-[180ms] ease-[var(--ease-brand)]',
					failed
						? 'border-error'
						: 'border-border-strong focus-within:border-brand focus-within:ring-2 focus-within:ring-brand/20',
				)}
			>
				<TagInput
					workspaceId={workspaceId}
					conversationParticipantIds={conversationParticipantIds}
					selfActorId={selfActorId}
					initialSegments={initialSegments}
					ariaLabel="Edit message"
					placeholder="Edit your message"
					disabled={saving}
					autoFocus
					className={cn('min-h-[84px] max-h-64 px-3 pt-2.5', saving && 'opacity-60')}
					onChange={handleChange}
					onKeyDown={(e) => {
						if (e.key === 'Enter' && !e.shiftKey) {
							e.preventDefault()
							save()
						}
						if (e.key === 'Escape') {
							e.preventDefault()
							if (!saving) onCancel()
						}
					}}
				/>
				<div className="flex flex-wrap items-center justify-end gap-2 px-3 pt-1 pb-2.5">
					<span className="hidden min-w-0 flex-1 truncate text-[11px] text-muted-foreground @xl:block">
						@ tags · Enter saves · Shift+Enter new line · Esc cancels
					</span>
					<div className="ml-auto flex items-center gap-2">
						{length >= COUNTER_FROM ? (
							<span
								className={cn(
									'text-[11px] tabular-nums',
									over ? 'text-error' : 'text-muted-foreground',
								)}
							>
								{length} / {MESSAGE_MAX_LENGTH}
							</span>
						) : null}
						<Button
							size="sm"
							variant="outline"
							className="hover:border-border-strong"
							onClick={onCancel}
							disabled={saving}
						>
							Cancel
						</Button>
						<Button size="sm" onClick={save} disabled={!canSave} className="hover:bg-primary/90">
							{saving ? (
								<>
									<Spinner aria-hidden />
									Saving…
								</>
							) : (
								'Save'
							)}
						</Button>
					</div>
				</div>
			</div>
			{failed ? (
				<p role="alert" className="text-[11.5px] text-error">
					Couldn't save your edit. Your text is still here.
				</p>
			) : null}
			{notified.length > 2 ? (
				<p className="text-[11.5px] text-muted-foreground">
					{notified.length} agents will get this when you save.
				</p>
			) : (
				notified.map((name) => (
					<p key={name} className="text-[11.5px] text-muted-foreground">
						{name} will get this when you save.
					</p>
				))
			)}
		</div>
	)
}
