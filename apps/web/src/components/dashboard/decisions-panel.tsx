import { MarkdownContent } from '@/components/shared/markdown-content'
import { RelativeTime } from '@/components/shared/relative-time'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { Textarea } from '@/components/ui/textarea'
import { useActors } from '@/hooks/use-actors'
import {
	useNotifications,
	useRespondNotification,
	useUpdateNotification,
} from '@/hooks/use-notifications'
import type { ActorListItem, NotificationResponse } from '@/lib/api'
import { resolveNavigationTarget } from '@/lib/navigation'
import { useWorkspace } from '@/lib/workspace-context'
import { Link, useNavigate } from '@tanstack/react-router'
import { ChevronDown, ChevronRight, ExternalLink, MessageSquare, Send, UserCog } from 'lucide-react'
import { useMemo, useState } from 'react'
import { toast } from 'sonner'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

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

/** A notification has a HumanLayer-style raw permission prompt if it asks the
 * user to authorize a tool call. We collapse these so the agent's plain-English
 * plan stays front-and-center. */
function getRawPermissionPrompt(metadata: Record<string, unknown>): {
	toolName?: string
	toolInput?: unknown
	prompt?: string
} | null {
	const toolName = typeof metadata.tool_name === 'string' ? metadata.tool_name : undefined
	const prompt =
		typeof metadata.permission_prompt === 'string' ? metadata.permission_prompt : undefined
	const toolInput = 'tool_input' in metadata ? metadata.tool_input : undefined
	if (!toolName && !prompt && toolInput === undefined) return null
	return { toolName, toolInput, prompt }
}

interface DecisionCardProps {
	notification: NotificationResponse
	actorsById: Map<string, ActorListItem>
	onShipIt: (notification: NotificationResponse) => void
	onAskForChanges: (notification: NotificationResponse, message: string) => void
	onTakeOver: (notification: NotificationResponse) => void
}

function DecisionCard({
	notification,
	actorsById,
	onShipIt,
	onAskForChanges,
	onTakeOver,
}: DecisionCardProps) {
	const { workspaceId } = useWorkspace()
	const metadata = notification.metadata ?? {}
	const suggestion = metadata.suggestion as string | undefined
	const urgencyLabel = metadata.urgency_label as string | undefined
	const sourceActor = actorsById.get(notification.sourceActorId)
	const primaryObjectId = notification.objectId
	const metadataLinks = extractMetadataObjectLinks(metadata as Record<string, unknown>).filter(
		(link) => link.objectId !== primaryObjectId,
	)
	const rawPermission = getRawPermissionPrompt(metadata as Record<string, unknown>)

	const [revisionOpen, setRevisionOpen] = useState(false)
	const [revisionText, setRevisionText] = useState('')
	const [rawOpen, setRawOpen] = useState(false)

	const handleRevisionSubmit = () => {
		const trimmed = revisionText.trim()
		if (!trimmed) return
		onAskForChanges(notification, trimmed)
		setRevisionText('')
		setRevisionOpen(false)
	}

	return (
		<Card className="shadow-sm">
			<CardHeader className="pb-3">
				<div className="flex items-center justify-between gap-2">
					<Badge variant="secondary">Needs your call</Badge>
					{urgencyLabel && <Badge variant="destructive">{urgencyLabel}</Badge>}
				</div>
				<CardTitle className="text-lg leading-snug">
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
			</CardHeader>
			<CardContent className="space-y-4">
				{/* Plain-English plan — front and center */}
				{notification.content && (
					<div className="text-base text-foreground">
						<MarkdownContent content={notification.content} />
					</div>
				)}

				{suggestion && (
					<div className="rounded-md bg-muted p-3 text-sm">
						<MarkdownContent content={suggestion} />
					</div>
				)}

				{/* Linked objects from metadata — clickable chips */}
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

				{/* Three primary steer actions — ≥44px touch targets */}
				<div className="flex flex-wrap gap-2">
					<Button size="lg" onClick={() => onShipIt(notification)} className="min-w-[140px]">
						<Send className="mr-2 h-4 w-4" />
						Ship it
					</Button>
					<Button
						size="lg"
						variant="outline"
						onClick={() => setRevisionOpen((v) => !v)}
						className="min-w-[140px]"
						aria-expanded={revisionOpen}
					>
						<MessageSquare className="mr-2 h-4 w-4" />
						Ask for changes
					</Button>
					<Button
						size="lg"
						variant="outline"
						onClick={() => onTakeOver(notification)}
						className="min-w-[140px]"
					>
						<UserCog className="mr-2 h-4 w-4" />
						Take over
					</Button>
				</div>

				{/* Inline revision input — opened by "Ask for changes" */}
				{revisionOpen && (
					<div className="space-y-2">
						<Textarea
							value={revisionText}
							onChange={(e) => setRevisionText(e.target.value)}
							placeholder="What should change? Be specific — the agent will fold this into the next iteration."
							rows={3}
							autoFocus
						/>
						<div className="flex gap-2">
							<Button size="sm" disabled={!revisionText.trim()} onClick={handleRevisionSubmit}>
								Send
							</Button>
							<Button
								size="sm"
								variant="ghost"
								onClick={() => {
									setRevisionOpen(false)
									setRevisionText('')
								}}
							>
								Cancel
							</Button>
						</div>
					</div>
				)}

				{/* HumanLayer-style raw permission prompt — collapsed by default */}
				{rawPermission && (
					<div className="border-t pt-3">
						<button
							type="button"
							onClick={() => setRawOpen((v) => !v)}
							className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
							aria-expanded={rawOpen}
						>
							{rawOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
							{rawOpen ? 'Hide' : 'View'} raw permission request
						</button>
						{rawOpen && (
							<div className="mt-2 rounded-md bg-muted p-3 text-xs font-mono space-y-2">
								{rawPermission.toolName && (
									<div>
										<span className="text-muted-foreground">tool: </span>
										<span>{rawPermission.toolName}</span>
									</div>
								)}
								{rawPermission.prompt && (
									<div className="whitespace-pre-wrap">{rawPermission.prompt}</div>
								)}
								{rawPermission.toolInput !== undefined && (
									<pre className="whitespace-pre-wrap break-words">
										{JSON.stringify(rawPermission.toolInput, null, 2)}
									</pre>
								)}
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
			</CardFooter>
		</Card>
	)
}

/**
 * Decisions panel for the Bridge dashboard.
 *
 * Elevates pending notifications to first-class steer cards. Replaces generic
 * Approve/Reject with **Ship it / Ask for changes / Take over**. The agent's
 * plain-English plan is the body of each card — the user is editing intent,
 * not signing tool calls.
 *
 * Hidden entirely when no decisions are pending (the "empties to zero" pattern).
 * SSE-driven cache invalidation removes a card automatically when it resolves.
 */
export function DecisionsPanel() {
	const { workspaceId } = useWorkspace()
	const { data: notifications, isLoading } = useNotifications(workspaceId, {
		status: 'pending,seen',
	})
	const { data: actors } = useActors(workspaceId)
	const respondNotification = useRespondNotification(workspaceId)
	const updateNotification = useUpdateNotification(workspaceId)
	const navigate = useNavigate()

	const actorsById = useMemo(() => {
		const map = new Map<string, ActorListItem>()
		for (const actor of actors ?? []) {
			map.set(actor.id, actor)
		}
		return map
	}, [actors])

	// Only surface notifications that actually represent a decision — skip
	// good_news (informational) so the panel stays a pile that empties to zero.
	const pending = useMemo(
		() => (notifications ?? []).filter((n) => n.type !== 'good_news'),
		[notifications],
	)

	if (isLoading || pending.length === 0) return null

	const handleShipIt = (notification: NotificationResponse) => {
		respondNotification.mutate(
			{ id: notification.id, response: 'approved' },
			{
				onError: () => {
					toast.error('Could not ship it. Please try again.')
				},
			},
		)
	}

	const handleAskForChanges = (notification: NotificationResponse, message: string) => {
		respondNotification.mutate(
			{ id: notification.id, response: { type: 'text_reply', message } },
			{
				onError: () => {
					toast.error('Could not send your changes. Please try again.')
				},
			},
		)
	}

	const handleTakeOver = (notification: NotificationResponse) => {
		// Mark the decision as seen so the panel reflects that the user is now
		// driving — but don't resolve, since they haven't shipped or rejected.
		if (notification.status === 'pending') {
			updateNotification.mutate({ id: notification.id, data: { status: 'seen' } })
		}
		const target = resolveNavigationTarget(
			workspaceId,
			{ to: notification.objectId ? 'object' : 'objects' },
			notification,
		)
		if (target) navigate({ to: target.path, search: target.search })
	}

	return (
		<section aria-labelledby="decisions-heading" className="space-y-3">
			<div className="flex items-baseline justify-between">
				<h2 id="decisions-heading" className="text-sm font-semibold uppercase tracking-wide">
					Decisions
				</h2>
				<span className="text-xs text-muted-foreground">
					{pending.length} {pending.length === 1 ? 'card' : 'cards'}
				</span>
			</div>
			<div className="space-y-3">
				{pending.map((notification) => (
					<DecisionCard
						key={notification.id}
						notification={notification}
						actorsById={actorsById}
						onShipIt={handleShipIt}
						onAskForChanges={handleAskForChanges}
						onTakeOver={handleTakeOver}
					/>
				))}
			</div>
		</section>
	)
}
