import { useRelationships } from '@/hooks/use-relationships'
import { cn } from '@/lib/cn'
import { Link } from '@tanstack/react-router'
import { AlertTriangle, Archive } from 'lucide-react'

type KnowledgeStatus = 'draft' | 'validated' | 'deprecated'

interface KnowledgeStatusBannerProps {
	objectId: string
	workspaceId: string
	status: string
	type: string
}

/**
 * Banner shown at the top of knowledge articles when the article is `draft` or
 * `deprecated`, so readers immediately see whether the content is provisional
 * or stale. Nothing renders for `validated` (the implicit default) or for
 * non-knowledge types.
 */
export function KnowledgeStatusBanner({
	objectId,
	workspaceId,
	status,
	type,
}: KnowledgeStatusBannerProps) {
	if (type !== 'knowledge') return null
	if (status !== 'draft' && status !== 'deprecated') return null
	return <StatusBannerContent objectId={objectId} workspaceId={workspaceId} status={status} />
}

function StatusBannerContent({
	objectId,
	workspaceId,
	status,
}: {
	objectId: string
	workspaceId: string
	status: KnowledgeStatus
}) {
	// For deprecated articles, surface the newer article via a `supersedes` edge
	// from any outbound or inbound relationship so the reader can click through.
	const { data: rels } = useRelationships(
		workspaceId,
		status === 'deprecated' ? { target_id: objectId, type: 'supersedes' } : undefined,
	)
	const newerId = rels?.find((r) => r.type === 'supersedes' && r.targetId === objectId)?.sourceId

	const isDraft = status === 'draft'
	const Icon = isDraft ? AlertTriangle : Archive
	const bgClass = isDraft ? 'bg-warning/10 border-warning/40' : 'bg-muted border-border'
	const textClass = isDraft ? 'text-warning' : 'text-muted-foreground'
	const label = isDraft ? 'Draft article' : 'Deprecated article'
	const body = isDraft
		? 'This article is provisional. Content may be unverified — promote to "validated" once a reviewer confirms it.'
		: 'This article is out of date and has been superseded. Prefer the newer article below.'

	return (
		<div
			className={cn(
				'flex items-start gap-3 rounded-lg border px-4 py-3 mb-6 text-sm',
				bgClass,
			)}
			role="status"
		>
			<Icon className={cn('mt-0.5 shrink-0', textClass)} size={16} aria-hidden />
			<div className="flex flex-col gap-1">
				<div className={cn('font-medium', textClass)}>{label}</div>
				<div className="text-muted-foreground">{body}</div>
				{newerId && (
					<Link
						to="/$workspaceId/wiki/$articleId"
						params={{ workspaceId, articleId: newerId }}
						className="text-primary hover:underline text-xs"
					>
						Go to the current article →
					</Link>
				)}
			</div>
		</div>
	)
}
