import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { type FormEvent, type KeyboardEvent, useEffect, useRef, useState } from 'react'

/** A section name is free text. Compared without case, as the server does. */
export function findDuplicateSection(
	name: string,
	sections: Array<{ id: string; name: string }>,
	exceptId?: string,
): string | null {
	const wanted = name.trim().toLowerCase()
	const hit = sections.find((s) => s.id !== exceptId && s.name.trim().toLowerCase() === wanted)
	return hit ? `You already have a section called ${hit.name}.` : null
}

/**
 * The one-line name field for a new or renamed section. Enter saves, Escape cancels. A name that
 * is empty or already in use stays in the field with the reason beside it.
 */
export function SectionNameForm({
	initialName = '',
	submitLabel,
	sections,
	exceptId,
	onSubmit,
	onCancel,
}: {
	initialName?: string
	submitLabel: string
	sections: Array<{ id: string; name: string }>
	exceptId?: string
	/** Resolves when saved; a rejection shows its message under the field. */
	onSubmit: (name: string) => Promise<unknown> | undefined
	onCancel: () => void
}) {
	const [name, setName] = useState(initialName)
	const [error, setError] = useState<string | null>(null)
	const [saving, setSaving] = useState(false)
	const ref = useRef<HTMLInputElement>(null)
	useEffect(() => {
		ref.current?.focus()
		ref.current?.select()
		// A form opened from a menu far down the list must be on screen.
		ref.current?.scrollIntoView?.({ block: 'nearest' })
	}, [])

	const submit = async (e?: FormEvent) => {
		e?.preventDefault()
		const trimmed = name.trim()
		if (!trimmed) return
		const duplicate = findDuplicateSection(trimmed, sections, exceptId)
		if (duplicate) {
			setError(duplicate)
			return
		}
		setSaving(true)
		try {
			await onSubmit(trimmed)
		} catch (err) {
			setError(err instanceof Error && err.message ? err.message : "Couldn't save the section.")
			setSaving(false)
		}
	}
	const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
		if (e.key === 'Escape') {
			e.preventDefault()
			onCancel()
		}
	}

	return (
		<form onSubmit={submit} className="flex flex-col gap-1.5 px-2 py-1.5">
			<div className="flex items-center gap-2">
				<Input
					ref={ref}
					value={name}
					onChange={(e) => {
						setName(e.target.value)
						setError(null)
					}}
					onKeyDown={onKeyDown}
					placeholder="Section name"
					aria-label="Section name"
					aria-invalid={error ? true : undefined}
					aria-describedby={error ? 'section-name-error' : undefined}
					maxLength={60}
					className="h-8 flex-1 rounded-full text-[13px]"
				/>
				<Button type="submit" size="sm" disabled={saving || name.trim() === ''}>
					{submitLabel}
				</Button>
				<Button type="button" variant="ghost" size="sm" onClick={onCancel}>
					Cancel
				</Button>
			</div>
			{error ? (
				<p id="section-name-error" role="alert" className="px-3 text-xs text-destructive">
					{error}
				</p>
			) : null}
		</form>
	)
}
