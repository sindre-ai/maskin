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
	/** `inline` in running text · `block` as a list row · `pill` as a bordered
	 *  citation chip on a message's REFERENCED rail. */
	variant?: 'inline' | 'block' | 'pill'
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
	const query = useObject(objectId, { enabled: !providedObject })
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

	// The citation chip: a bordered pill that leads with the type as a dot so
	// the object's own name is the thing you read (mockup 440). The badge-led
	// inline form put two badges before every title, which turned a rail of
	// four citations into a wall of chrome.
	if (variant === 'pill') {
		return (
			<Link
				to="/$workspaceId/objects/$objectId"
				params={{ workspaceId, objectId: object.id }}
				className={cn(
					'inline-flex max-w-full items-center gap-[7px] rounded-[9px] border border-border bg-card py-1 pr-2.5 pl-2 text-[11.5px] transition-colors hover:border-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
					className,
				)}
			>
				{showType && <TypeBadge type={object.type} variant="dot" />}
				<span className="min-w-0 truncate font-semibold text-foreground">{title}</span>
				{showStatus && (
					<StatusBadge
						status={object.status}
						variant="word"
						className="text-[10.5px] font-semibold"
					/>
				)}
			</Link>
		)
	}

	const baseClasses =
		variant === 'inline'
			? 'inline-flex items-center gap-1.5 align-middle rounded px-1 -mx-1 py-0.5 hover:bg-accent/50 focus-visible:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring text-foreground transition-colors'
			: 'flex items-start gap-2 rounded-md px-2 py-1.5 hover:bg-accent/50 focus-visible:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring transition-colors'

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
