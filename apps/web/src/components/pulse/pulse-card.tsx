import { MarkdownContent } from '@/components/shared/markdown-content'
import { RelativeTime } from '@/components/shared/relative-time'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Separator } from '@/components/ui/separator'
import type { ActorListItem, NotificationResponse } from '@/lib/api'
import { resolveNavigationTarget } from '@/lib/navigation'
import { useWorkspace } from '@/lib/workspace-context'
import { Link, useNavigate } from '@tanstack/react-router'
import { ArrowUpRight, ExternalLink } from 'lucide-react'
import { useState } from 'react'
import { NotificationInput } from './notification-input'

const typeLabels: Record<string, string> = {
	needs_input: 'Agent needs you',
	recommendation: 'Pattern detected',
	good_news: 'Good news',
	alert: 'Alert',
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Metadata keys ending in _id that contain valid UUIDs, excluding known non-object fields. */
const NON_OBJECT_ID_KEYS = new Set(['source_actor_id', 'target_actor_id', 'session_id'])

function extractMetadataObjectLinks(
	metadata: Record<string, unknown>,
): { label: string; objectId: string }[] {
	const links: { label: string; objectId: string }[] = []
	for (const [key, value] of Object.entries(metadata)) {
		if (NON_OBJECT_ID_KEYS.has(key)) continue
		if (typeof value === 'string' && key.endsWith('_id') && UUID_RE.test(value)) {
			const label = key
				.replace(/_id$/, '')
				.replace(/_/g, ' ')
				.replace(/^\w/, (c) => c.toUpperCase())
			links.push({ label, objectId: value })
		}
	}
	return links
}

export interface NotificationAction {
	label: string
	response?: unknown
	variant?: 'default' | 'outline' | 'ghost' | 'destructive'
	navigate?: { to: string; id?: string }
}

export function resolveActions(
	notification: NotificationResponse,
	metadata: Record<string, unknown>,
): NotificationAction[] {
	const defined = metadata.actions as NotificationAction[] | undefined
	if (defined && Array.isArray(defined) && defined.length > 0) {
		const valid = defined.filter(
			(a) =>
				a &&
				typeof a === 'object' &&
				typeof a.label === 'string' &&
				('response' in a || 'navigate' in a),
		)
		if (valid.length > 0) return valid
	}

	if (metadata.input_type) return []

	const hasObject = !!notification.objectId
	switch (notification.type) {
		case 'recommendation':
			return [
				{
					label: hasObject ? 'View object' : 'View objects',
					response: 'view_object',
					navigate: { to: hasObject ? 'object' : 'objects' },
				},
			]
		case 'alert':
			return [
				{
					label: hasObject ? 'Review' : 'Review tasks',
					response: 'acknowledged',
					navigate: { to: hasObject ? 'object' : 'objects' },
				},
			]
		case 'good_news':
			return hasObject
				? [{ label: 'View', response: 'acknowledged', navigate: { to: 'object' } }]
				: []
		default:
			return []
	}
}

interface PulseCardProps {
	notification: NotificationResponse
	actorsById: Map<string, ActorListItem>
	onAction: (
		notification: NotificationResponse,
		response: unknown,
		navigate?: { to: string; id?: string },
	) => void
	onDismiss: (id: string) => void
}

export function PulseCard({ notification, actorsById, onAction, onDismiss }: PulseCardProps) {
	const { workspaceId } = useWorkspace()
	const navigate = useNavigate()
	const metadata = notification.metadata ?? {}
	const metaText = metadata.meta_text as string | undefined
	const rawTags = metadata.tags
	const tags = Array.isArray(rawTags)
		? rawTags.filter((t): t is string => typeof t === 'string')
		: undefined
	const suggestion = metadata.suggestion as string | undefined
	const urgencyLabel = metadata.urgency_label as string | undefined
	const inputType = metadata.input_type as string | undefined
	const sourceActor = actorsById.get(notification.sourceActorId)
	const isResolved = notification.status === 'resolved' || notification.status === 'dismissed'

	const actions = resolveActions(notification, metadata)
	const showReplyInput = !!notification.sessionId && !inputType

	const [replyOpen, setReplyOpen] = useState(false)
	const [replyText, setReplyText] = useState('')

	const primaryObjectId = notification.objectId

	// Extract secondary object links from metadata
	const metadataLinks = extractMetadataObjectLinks(metadata as Record<string, unknown>).filter(
		(link) => link.objectId !== primaryObjectId,
	)

	const handleActionClick = (action: NotificationAction) => {
		if ('response' in action) {
			onAction(notification, action.response, action.navigate)
		} else if (action.navigate) {
			const target = resolveNavigationTarget(workspaceId, action.navigate, notification)
			if (target) navigate({ to: target.path, search: target.search })
		}
	}

	const handleReplySubmit = () => {
		if (!replyText.trim()) return
		onAction(notification, { type: 'text_reply', message: replyText })
		setReplyText('')
		setReplyOpen(false)
	}

	return (
		<Card className={isResolved ? 'opacity-60' : undefined}>
			<CardHeader className="pb-2">
				<div className="flex items-center justify-between">
					<div className="flex items-center gap-2">
						<Badge variant="secondary">{typeLabels[notification.type] ?? notification.type}</Badge>
						{isResolved && (
							<Badge variant="outline">
								{notification.status === 'resolved' ? 'Resolved' : 'Dismissed'}
							</Badge>
						)}
					</div>
					{urgencyLabel && (
						<Badge variant={notification.type === 'needs_input' ? 'destructive' : 'outline'}>
							{urgencyLabel}
						</Badge>
					)}
				</div>
				<CardTitle className="text-base">
					{primaryObjectId ? (
						<Link
							to="/$workspaceId/objects/$objectId"
							params={{ workspaceId, objectId: primaryObjectId }}
							className="text-foreground hover:underline"
						>
							{notification.title}
						</Link>
					) : (
						notification.title
					)}
				</CardTitle>
				{notification.content && (
					<div className="text-sm text-muted-foreground">
						<MarkdownContent content={notification.content} />
					</div>
				)}
			</CardHeader>
			<CardContent className="space-y-3">
				{/* Meta info */}
				{metaText && (
					<div className="text-xs text-muted-foreground">
						<MarkdownContent content={metaText} size="xs" />
					</div>
				)}

				{/* Linked objects from metadata */}
				{metadataLinks.length > 0 && (
					<div className="flex flex-wrap gap-2">
						{metadataLinks.map((link) => (
							<Link
								key={link.objectId}
								to="/$workspaceId/objects/$objectId"
								params={{ workspaceId, objectId: link.objectId }}
								className="inline-flex items-center gap-1 text-xs text-primary hover:underline min-h-[28px] px-2 py-1 rounded-md bg-muted/50"
							>
								<ExternalLink className="h-3 w-3" />
								{link.label}
							</Link>
						))}
					</div>
				)}

				{/* Tags */}
				{tags && tags.length > 0 && (
					<div className="flex flex-wrap gap-1.5">
						{tags.map((tag) => (
							<Badge key={tag} variant="outline">
								{tag}
							</Badge>
						))}
					</div>
				)}

				{/* Agent-defined input */}
				{inputType && (
					<NotificationInput
						metadata={metadata}
						onSubmit={(response) => onAction(notification, response)}
					/>
				)}

				{/* Agent suggestion */}
				{suggestion && (
					<div className="rounded-md bg-muted p-3 text-sm text-muted-foreground">
						<MarkdownContent content={suggestion} />
					</div>
				)}

				{/* Action buttons */}
				{!isResolved && (
					<div className="flex items-center gap-2">
						{actions.map((action, i) => (
							<Button
								key={action.label}
								size="sm"
								variant={action.variant ?? (i === 0 ? 'default' : 'outline')}
								onClick={() => handleActionClick(action)}
							>
								{action.label}
								{action.navigate && <ArrowUpRight className="ml-1 h-3 w-3" />}
							</Button>
						))}
						{actions.length > 0 && <Separator orientation="vertical" className="h-4" />}
						<Button
							size="sm"
							variant="ghost"
							className="text-muted-foreground"
							onClick={() => onDismiss(notification.id)}
						>
							Dismiss
						</Button>
					</div>
				)}

				{/* Collapsible text reply for session-linked notifications */}
				{showReplyInput && !isResolved && (
					<div>
						{!replyOpen ? (
							<Button
								variant="link"
								size="sm"
								className="h-auto p-0 text-xs text-muted-foreground hover:text-foreground"
								onClick={() => setReplyOpen(true)}
							>
								Reply to agent...
							</Button>
						) : (
							<div className="flex gap-2">
								<Input
									value={replyText}
									onChange={(e) => setReplyText(e.target.value)}
									placeholder="Type a reply..."
									className="h-8 text-sm"
									onKeyDown={(e) => {
										if (e.key === 'Enter') handleReplySubmit()
									}}
								/>
								<Button size="sm" disabled={!replyText.trim()} onClick={handleReplySubmit}>
									Send
								</Button>
							</div>
						)}
					</div>
				)}
			</CardContent>
			<CardFooter className="text-xs text-muted-foreground border-t pt-3 gap-1.5">
				{sourceActor && (
					<>
						<span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-muted text-[10px] font-semibold">
							{sourceActor.name.charAt(0).toUpperCase()}
						</span>
						<span>{sourceActor.name}</span>
						<span>&middot;</span>
					</>
				)}
				<RelativeTime date={notification.createdAt} />
				{notification.sessionId && (
					<>
						<span>&middot;</span>
						<span>Session</span>
					</>
				)}
				{primaryObjectId && (
					<>
						<span>&middot;</span>
						<Link
							to="/$workspaceId/objects/$objectId"
							params={{ workspaceId, objectId: primaryObjectId }}
							className="inline-flex items-center gap-1 text-primary hover:underline"
						>
							<ExternalLink className="h-3 w-3" />
							Linked object
						</Link>
					</>
				)}
			</CardFooter>
		</Card>
	)
}
