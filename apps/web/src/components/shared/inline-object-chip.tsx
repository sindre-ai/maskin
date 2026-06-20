import { useObject } from '@/hooks/use-objects'
import { cn } from '@/lib/cn'
import { Link } from '@tanstack/react-router'
import { Box, CheckSquare, Lightbulb } from 'lucide-react'
import type { ReactNode } from 'react'

/**
 * Compact, inline-safe chip for an object reference inside running text
 * (e.g. an agent's chat message). All elements are <span>/<a> so the chip
 * can mount inside a <p> without producing a <div>-inside-<p> hydration
 * error. Title is fetched lazily via `useObject` and TanStack Query, so two
 * chips for the same id share a single fetch.
 *
 * For richer surfaces (object pages, related-objects tables) use
 * `ObjectReference` instead — it carries the full title + type + status row
 * and the block-layout variant.
 */
export function InlineObjectChip({
	objectId,
	workspaceId,
	className,
}: {
	objectId: string
	workspaceId: string
	className?: string
}) {
	const query = useObject(objectId)
	const object = query.data
	const isLoading = query.isLoading
	const isMissing = !query.isLoading && !query.data

	if (isLoading) {
		return (
			<span
				aria-busy="true"
				className={cn(
					'inline-flex items-center gap-1 rounded-full border border-border bg-bg-surface px-2 py-0.5 align-middle text-xs',
					className,
				)}
			>
				<span className="inline-block h-3 w-16 animate-pulse rounded bg-muted" aria-hidden />
			</span>
		)
	}

	if (isMissing || !object) {
		return (
			<span
				className={cn(
					'inline-flex max-w-full items-center gap-1 rounded-full border border-border bg-bg-surface px-2 py-0.5 align-middle text-muted-foreground text-xs italic opacity-70',
					className,
				)}
				title="This object was deleted or is unavailable"
			>
				deleted object
			</span>
		)
	}

	const title = object.title?.trim() || 'Untitled'
	return (
		<Link
			to="/$workspaceId/objects/$objectId"
			params={{ workspaceId, objectId: object.id }}
			className={cn(
				'inline-flex max-w-full items-center gap-1 rounded-full border border-border bg-bg-surface px-2 py-0.5 align-middle text-foreground text-xs no-underline transition-colors hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
				typeBgClass(object.type),
				className,
			)}
		>
			<TypeIcon type={object.type} />
			<span className="max-w-[14rem] truncate">{title}</span>
		</Link>
	)
}

function TypeIcon({ type }: { type: string }): ReactNode {
	const iconProps = { size: 11, 'aria-hidden': true, className: 'shrink-0' } as const
	switch (type) {
		case 'bet':
			return <Box {...iconProps} />
		case 'task':
			return <CheckSquare {...iconProps} />
		case 'insight':
			return <Lightbulb {...iconProps} />
		default:
			return <Box {...iconProps} />
	}
}

/**
 * Per-type background colour using the live `--tp-{type}-bg` token. Falls back
 * to the neutral surface for unknown types (e.g. legacy `meeting`, `knowledge`)
 * — those still render with the icon + border + title.
 */
function typeBgClass(type: string): string | undefined {
	switch (type) {
		case 'bet':
			return 'bg-type-bet-bg text-type-bet-text'
		case 'task':
			return 'bg-type-task-bg text-type-task-text'
		case 'insight':
			return 'bg-type-insight-bg text-type-insight-text'
		default:
			return undefined
	}
}
