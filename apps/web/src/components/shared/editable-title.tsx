import { cn } from '@/lib/cn'
import { useEffect, useState } from 'react'

/** The document-scale heading both detail surfaces run their title at
 *  (mockup 1056–1096). Exported so a host can match it on a non-editable
 *  heading beside one of these. */
export const EDITABLE_TITLE_CLASS =
	'text-[clamp(20px,2.4vw,25px)] font-bold leading-[1.2] tracking-[-0.02em] text-foreground'

/**
 * Click-to-edit document heading, shared by object detail and loop detail.
 *
 * The heading stays a real `<h1>` at rest and only becomes a field once you ask
 * for it, so the document reads as the mockup draws it and still renames in
 * place. Commits on blur or Enter; Escape reverts; an empty or unchanged draft
 * is a no-op.
 */
export function EditableTitle({
	value,
	entityId,
	onChange,
	ariaLabel,
	placeholder = 'Untitled',
	className,
}: {
	value: string | null
	/** Identity of the record being titled — a route swap reuses this instance,
	 *  and this is what tells it the draft belongs to a different record now. */
	entityId: string
	/** Wire this to make the title editable in place. Omitted by read-only hosts
	 *  (the MCP-app embed), which keeps the plain heading. */
	// May return a promise. If it rejects, the field is reopened with the user's
	// draft intact rather than silently reverting to the old title.
	onChange?: (next: string) => unknown
	ariaLabel: string
	placeholder?: string
	className?: string
}) {
	const [editing, setEditing] = useState(false)
	const [draft, setDraft] = useState(value ?? '')
	useEffect(() => {
		if (!editing) setDraft(value ?? '')
	}, [value, editing])

	// The effect above deliberately holds the draft while you are typing — so
	// without this an in-flight edit would survive a route swap and blur would
	// commit the previous record's text onto the new one. Leaving edit mode as
	// well means the swap lands on the heading.
	const [trackedEntityId, setTrackedEntityId] = useState(entityId)
	if (trackedEntityId !== entityId) {
		setTrackedEntityId(entityId)
		setDraft(value ?? '')
		setEditing(false)
	}

	const commit = () => {
		setEditing(false)
		const next = draft.trim()
		if (!next || next === value) {
			setDraft(value ?? '')
			return
		}
		const result = onChange?.(next)
		if (result && typeof (result as Promise<unknown>).then === 'function') {
			void (result as Promise<unknown>).catch(() => {
				setDraft(next)
				setEditing(true)
			})
		}
	}

	if (editing) {
		return (
			<input
				// biome-ignore lint/a11y/noAutofocus: the field only exists once the reader asks to rename
				autoFocus
				value={draft}
				aria-label={ariaLabel}
				onChange={(e) => {
					setDraft(e.target.value)
				}}
				onBlur={commit}
				onKeyDown={(e) => {
					if (e.key === 'Enter' && !e.shiftKey) {
						e.preventDefault()
						e.currentTarget.blur()
					}
					if (e.key === 'Escape') {
						setDraft(value ?? '')
						setEditing(false)
					}
				}}
				className={cn(
					EDITABLE_TITLE_CLASS,
					'w-full border-none bg-transparent p-0 outline-none',
					className,
				)}
			/>
		)
	}

	return (
		<h1
			className={cn(
				EDITABLE_TITLE_CLASS,
				onChange && 'cursor-text rounded-lg transition-colors hover:bg-muted/60',
				className,
			)}
			title={onChange ? 'Click to edit' : undefined}
			tabIndex={onChange ? 0 : undefined}
			onClick={onChange ? () => setEditing(true) : undefined}
			onKeyDown={
				onChange
					? (e) => {
							if (e.key !== 'Enter' && e.key !== ' ') return
							e.preventDefault()
							setEditing(true)
						}
					: undefined
			}
		>
			{value ?? placeholder}
		</h1>
	)
}
