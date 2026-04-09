import { MarkdownContent } from '@/components/shared/markdown-content'
import { RelativeTime } from '@/components/shared/relative-time'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import type { ActorListItem, NotificationResponse } from '@/lib/api'
import { useState } from 'react'
import { NotificationInput } from './notification-input'

const typeLabels: Record<string, string> = {
	needs_input: 'Agent needs you',
	recommendation: 'Pattern detected',
	good_news: 'Good news',
	alert: 'Alert',
}

export interface NotificationAction {
	label: string
	response: unknown
	variant?: 'default' | 'outline' | 'ghost'
	navigate?: { to: string; id?: string }
}

export function resolveActions(
	notification: NotificationResponse,
	metadata: Record<string, unknown>,
): NotificationAction[] {
	const defined = metadata.actions as NotificationAction[] | undefined
	if (defined && Array.isArray(defined) && defined.length > 0) {
		const valid = defined.filter(
			(a) => a && typeof a === 'object' && typeof a.label === 'string' && 'response' in a,
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
				<CardTitle className="text-base">{notification.title}</CardTitle>
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
					<div className="rounded-md bg-muted p-3 text-sm text-foreground">
						<MarkdownContent content={suggestion} />
					</div>
				)}

				{/* Action buttons */}
				{!isResolved && (
					<div className="flex gap-2">
						{actions.map((action, i) => (
							<Button
								key={action.label}
								size="sm"
								variant={action.variant ?? (i === 0 ? 'default' : 'outline')}
								onClick={() => onAction(notification, action.response, action.navigate)}
							>
								{action.label}
							</Button>
						))}
						<Button size="sm" variant="ghost" onClick={() => onDismiss(notification.id)}>
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
			</CardFooter>
		</Card>
	)
}
