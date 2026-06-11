import { useObject } from '@/hooks/use-objects'
import type { ObjectResponse } from '@/lib/api'
import { cn } from '@/lib/cn'
import { Link } from '@tanstack/react-router'
import { Skeleton } from './loading-skeleton'
import { StatusBadge } from './status-badge'
import { TypeBadge } from './type-badge'

interface ObjectReferenceProps {
	objectId: string
	workspaceId: string
	object?: ObjectResponse
	variant?: 'inline' | 'block'
	showStatus?: boolean
	showType?: boolean
	className?: string
}

export function ObjectReference({
	objectId,
	workspaceId,
	object: providedObject,
	variant = 'inline',
	showStatus = true,
	showType = true,
	className,
}: ObjectReferenceProps) {
	const query = useObject(providedObject ? '' : objectId)
	const object = providedObject ?? query.data
	const isLoading = !providedObject && query.isLoading
	const isMissing = !providedObject && !query.isLoading && !query.data

	if (isLoading) {
		return (
			<span
				className={cn(
					variant === 'inline' ? 'inline-flex' : 'flex',
					'items-center gap-1.5 align-middle',
					className,
				)}
				aria-busy="true"
			>
				<Skeleton className="h-4 w-24" />
			</span>
		)
	}

	if (isMissing || !object) {
		return (
			<span
				className={cn(
					variant === 'inline' ? 'inline-flex' : 'flex',
					'items-center gap-1.5 align-middle text-muted-foreground italic opacity-60',
					className,
				)}
				title="This object was deleted or is unavailable"
			>
				deleted object
			</span>
		)
	}

	const title = object.title || 'Untitled'
	const baseClasses =
		variant === 'inline'
			? 'inline-flex items-center gap-1.5 align-middle rounded px-1 -mx-1 py-0.5 hover:bg-accent/50 focus-visible:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring text-foreground transition-colors'
			: 'flex items-start gap-2 rounded-md px-2 py-1.5 hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring transition-colors'

	return (
		<Link
			to="/$workspaceId/objects/$objectId"
			params={{ workspaceId, objectId: object.id }}
			className={cn(baseClasses, className)}
		>
			<span className={cn('truncate', variant === 'block' && 'flex-1 min-w-0')}>{title}</span>
			{showType && <TypeBadge type={object.type} />}
			{showStatus && <StatusBadge status={object.status} />}
		</Link>
	)
}
