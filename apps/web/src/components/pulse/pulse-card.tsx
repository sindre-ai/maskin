import { RelativeTime } from '@/components/shared/relative-time'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
	Card,
	CardContent,
	CardDescription,
	CardFooter,
	CardHeader,
	CardTitle,
} from '@/components/ui/card'
import type { ActorListItem, NotificationResponse } from '@/lib/api'
import { useWorkspace } from '@/lib/workspace-context'
import { Link } from '@tanstack/react-router'
import { ArrowRight } from 'lucide-react'
import { NotificationInput } from './notification-input'

const typeLabels: Record<string, string> = {
	needs_input: 'Agent needs you',
	recommendation: 'Pattern detected',
	good_news: 'Good news',
	alert: 'Alert',
}

interface PulseCardProps {
	notification: NotificationResponse
	actorsById: Map<string, ActorListItem>
	onRespond: (id: string, response: unknown) => void
	onDismiss: (id: string) => void
}

export function PulseCard({ notification, actorsById, onRespond, onDismiss }: PulseCardProps) {
	const { workspaceId } = useWorkspace()
	const metadata = notification.metadata ?? {}
	const metaText = metadata.meta_text as string | undefined
	const tags = metadata.tags as string[] | undefined
	const suggestion = metadata.suggestion as string | undefined
	const urgencyLabel = metadata.urgency_label as string | undefined
	const inputType = metadata.input_type as string | undefined
	const sourceActor = actorsById.get(notification.sourceActorId)

	return (
		<Card>
			<CardHeader className="pb-2">
				<div className="flex items-center justify-between">
					<Badge variant="secondary">{typeLabels[notification.type] ?? notification.type}</Badge>
					{urgencyLabel && (
						<Badge variant={notification.type === 'needs_input' ? 'destructive' : 'outline'}>
							{urgencyLabel}
						</Badge>
					)}
				</div>
				<CardTitle className="text-base">{notification.title}</CardTitle>
				{notification.content && <CardDescription>{notification.content}</CardDescription>}
			</CardHeader>
			<CardContent className="space-y-3">
				{/* Meta info */}
				{metaText && <p className="text-xs text-muted-foreground">{metaText}</p>}

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
						onSubmit={(response) => onRespond(notification.id, response)}
					/>
				)}

				{/* Agent suggestion */}
				{suggestion && (
					<div className="rounded-md bg-muted p-3 text-sm text-muted-foreground">{suggestion}</div>
				)}

				{/* Action buttons */}
				<div className="flex gap-2">
					{notification.type === 'recommendation' && !inputType && (
						<>
							<Button size="sm" onClick={() => onRespond(notification.id, 'create_bet')}>
								Create bet
							</Button>
							<Button
								size="sm"
								variant="outline"
								onClick={() => onRespond(notification.id, 'show_data')}
							>
								Show data
							</Button>
						</>
					)}
					{notification.type === 'alert' && !inputType && (
						<Button size="sm" onClick={() => onRespond(notification.id, 'acknowledged')}>
							Review tasks
						</Button>
					)}
					<Button size="sm" variant="ghost" onClick={() => onDismiss(notification.id)}>
						Dismiss
					</Button>
				</div>
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
				{notification.objectId && (
					<Link
						to="/$workspaceId/objects/$objectId"
						params={{ workspaceId, objectId: notification.objectId }}
						className="ml-auto flex items-center gap-1 text-primary hover:underline"
					>
						View <ArrowRight className="h-3 w-3" />
					</Link>
				)}
			</CardFooter>
		</Card>
	)
}
