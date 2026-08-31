import { ActorAvatar } from '@/components/shared/actor-avatar'
import { TypeBadge } from '@/components/shared/type-badge'
import type { ObjectResponse } from '@/lib/api'
import { cn } from '@/lib/cn'
import { highlightText } from '@/lib/search-highlight'
import type { ReactNode } from 'react'

/**
 * Shared rendering for a cross-entity search result row (command palette
 * "Jump to" and the `/search` page) — both surfaces rank the same
 * `useWorkspaceSearch` index and must render it identically.
 */

interface SearchRowIconProps {
	id: string
	title: string
	group: string
	object?: ObjectResponse
	className?: string
	/** Rendered when the row is neither an object nor an agent. The two
	 *  surfaces differ here (the palette shows the group's own glyph, /search
	 *  shows a plain muted swatch), so it stays caller-supplied. */
	fallback: ReactNode
}

export function SearchRowIcon({
	id,
	title,
	group,
	object,
	className,
	fallback,
}: SearchRowIconProps) {
	if (object) {
		return (
			<TypeBadge
				type={object.type}
				variant="tile"
				className={cn('size-[22px] shrink-0', className)}
			/>
		)
	}
	if (group === 'agents') {
		return (
			<ActorAvatar
				id={id}
				name={title}
				type="agent"
				className={cn('size-[22px] shrink-0 text-[9px]', className)}
			/>
		)
	}
	return fallback
}

export function SearchRowTitle({
	title,
	sub,
	query,
	className,
}: {
	title: string
	sub?: string
	query: string
	className?: string
}) {
	return (
		<span className={cn('truncate text-[13px] text-foreground', className)}>
			{highlightText(title, query)}
			{sub ? <span className="font-normal text-muted-foreground"> — {sub}</span> : null}
		</span>
	)
}
