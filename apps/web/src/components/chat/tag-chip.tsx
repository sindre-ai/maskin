import { cn } from '@/lib/cn'
import { Link } from '@tanstack/react-router'

/** 'card' sits on a light surface (the edit card); 'plate' on the dark own-message plate. */
export type TagChipSurface = 'card' | 'plate'

/** One class string for the React chip and for the chip the tag input draws into its editable
 *  DOM, so a tag looks the same while typing and once sent. */
export function tagChipClass(surface: TagChipSurface, isSelf: boolean): string {
	return cn(
		'rounded-md px-1 py-px',
		surface === 'plate' ? 'font-medium' : 'font-semibold',
		isSelf
			? 'bg-warning/10 text-warning'
			: surface === 'plate'
				? 'bg-primary-foreground/15 text-primary-foreground'
				: 'bg-brand/10 text-brand',
	)
}

/** A tag inside a sentence. Agents link to their page, people have none so stay plain. */
export function TagChip({
	workspaceId,
	id,
	label,
	surface,
	isSelf,
	linkable,
}: {
	workspaceId: string
	id: string
	label: string
	surface: TagChipSurface
	isSelf: boolean
	linkable: boolean
}) {
	const className = tagChipClass(surface, isSelf)
	if (linkable && !isSelf) {
		return (
			<Link
				to="/$workspaceId/agents/$agentId"
				params={{ workspaceId, agentId: id }}
				className={className}
			>
				@{label}
			</Link>
		)
	}
	return <span className={className}>@{label}</span>
}
