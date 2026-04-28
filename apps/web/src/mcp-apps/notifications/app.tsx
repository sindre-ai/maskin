import { EmptyState } from '@/components/shared/empty-state'
import { MarkdownContent } from '@/components/shared/markdown-content'
import { RelativeTime } from '@/components/shared/relative-time'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Bell, Bot, Check, MessageSquare, X } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { useCallTool, useToolResult } from '../shared/mcp-app-provider'
import { isArray, isObject, safeParseJson, unwrapEnvelope } from '../shared/parse'
import { renderMcpApp } from '../shared/render'
import type { NotificationResponse } from '../shared/types'
import { WebAppLink, useWebAppHref } from '../shared/web-app-link'

const TYPE_LABELS: Record<string, string> = {
	needs_input: 'Agent needs you',
	recommendation: 'Recommendation',
	good_news: 'Good news',
	alert: 'Alert',
}

const STATUS_VARIANTS: Record<string, 'default' | 'secondary' | 'destructive' | 'outline'> = {
	pending: 'default',
	seen: 'secondary',
	resolved: 'outline',
	dismissed: 'outline',
}

function NotificationsApp() {
	const toolResult = useToolResult()

	if (!toolResult) {
		return <div className="p-4 text-muted-foreground text-sm">Waiting for data...</div>
	}

	const text = toolResult.result.content?.find(
		(c: { type: string; text?: string }) => c.type === 'text',
	)?.text
	if (!text) return <div className="p-4 text-muted-foreground text-sm">No data received</div>

	const data = safeParseJson(text)
	if (!data) return <div className="p-4 text-sm text-foreground">{text}</div>

	const unwrapped = unwrapEnvelope(data)

	switch (toolResult.toolName) {
		case 'list_notifications':
			return isArray(unwrapped) ? (
				<NotificationListView notifications={unwrapped as NotificationResponse[]} />
			) : (
				<div className="p-4 text-sm text-foreground">{text}</div>
			)
		case 'create_notification':
		case 'get_notification':
		case 'update_notification':
			return isObject<NotificationResponse>(data, 'id', 'title') ? (
				<NotificationDetailView notification={data} />
			) : (
				<div className="p-4 text-sm text-foreground">{text}</div>
			)
		case 'delete_notification':
			return <NotificationDeletedView />
		default:
			if (isArray(unwrapped)) {
				return <NotificationListView notifications={unwrapped as NotificationResponse[]} />
			}
			return isObject<NotificationResponse>(data, 'id', 'title') ? (
				<NotificationDetailView notification={data} />
			) : (
				<div className="p-4 text-sm text-foreground">{text}</div>
			)
	}
}

function NotificationListView({ notifications }: { notifications: NotificationResponse[] }) {
	const [local, setLocal] = useState<NotificationResponse[]>(notifications)

	useEffect(() => {
		setLocal(notifications)
	}, [notifications])

	if (!local.length) {
		return (
			<EmptyState
				title="No notifications"
				description="No notifications matching the current filter"
			/>
		)
	}

	const onUpdate = (id: string, patch: Partial<NotificationResponse>) =>
		setLocal((cur) => cur.map((n) => (n.id === id ? { ...n, ...patch } : n)))

	const onRemove = (id: string) => setLocal((cur) => cur.filter((n) => n.id !== id))

	return (
		<div className="p-4 space-y-2">
			<div className="flex justify-end mb-2">
				<WebAppLink target={{ kind: 'pulse' }} label="Open Pulse in Maskin" />
			</div>
			{local.map((n) => (
				<NotificationRow
					key={n.id}
					notification={n}
					onUpdate={(patch) => onUpdate(n.id, patch)}
					onRemove={() => onRemove(n.id)}
				/>
			))}
		</div>
	)
}

function NotificationRow({
	notification,
	onUpdate,
	onRemove,
}: {
	notification: NotificationResponse
	onUpdate: (patch: Partial<NotificationResponse>) => void
	onRemove: () => void
}) {
	const callTool = useCallTool()
	const [busy, setBusy] = useState(false)
	const objectHref = useWebAppHref(
		notification.objectId ? { kind: 'object', id: notification.objectId } : { kind: 'pulse' },
	)

	const updateStatus = useCallback(
		async (status: 'seen' | 'resolved' | 'dismissed') => {
			setBusy(true)
			const previous = notification.status
			onUpdate({ status })
			try {
				await callTool('update_notification', { id: notification.id, status })
			} catch (err) {
				onUpdate({ status: previous })
				console.error('Failed to update notification', err)
			} finally {
				setBusy(false)
			}
		},
		[callTool, notification.id, notification.status, onUpdate],
	)

	const onDelete = useCallback(async () => {
		setBusy(true)
		try {
			await callTool('delete_notification', { id: notification.id })
			onRemove()
		} catch (err) {
			console.error('Failed to delete notification', err)
		} finally {
			setBusy(false)
		}
	}, [callTool, notification.id, onRemove])

	const isResolved = notification.status === 'resolved' || notification.status === 'dismissed'
	const typeLabel = TYPE_LABELS[notification.type] ?? notification.type

	return (
		<div
			className={`rounded-lg border border-border bg-bg-surface p-3 space-y-2 transition-opacity ${
				isResolved ? 'opacity-60' : ''
			}`}
		>
			<div className="flex items-start gap-3">
				<NotificationIcon type={notification.type} />
				<div className="flex-1 min-w-0">
					<div className="flex items-center gap-2 flex-wrap">
						<span className="text-xs text-muted-foreground">{typeLabel}</span>
						<Badge variant={STATUS_VARIANTS[notification.status] ?? 'secondary'}>
							{notification.status}
						</Badge>
						{notification.createdAt && (
							<span className="text-xs text-muted-foreground">
								<RelativeTime date={notification.createdAt} />
							</span>
						)}
					</div>
					<h3 className="text-sm font-medium text-foreground mt-1">{notification.title}</h3>
					{notification.content && (
						<div className="text-xs text-muted-foreground mt-1 line-clamp-3">
							<MarkdownContent content={notification.content} />
						</div>
					)}
				</div>
			</div>
			<div className="flex items-center gap-2 justify-end">
				{objectHref && (
					<a
						href={objectHref}
						target="_blank"
						rel="noreferrer"
						className="text-xs text-muted-foreground hover:text-foreground underline-offset-2 hover:underline"
					>
						Open
					</a>
				)}
				{notification.status === 'pending' && (
					<Button
						variant="ghost"
						size="sm"
						onClick={() => updateStatus('seen')}
						disabled={busy}
						aria-label="Mark seen"
					>
						<Check className="size-3.5 mr-1" />
						Mark seen
					</Button>
				)}
				{!isResolved && (
					<Button
						variant="ghost"
						size="sm"
						onClick={() => updateStatus('resolved')}
						disabled={busy}
						aria-label="Resolve"
					>
						Resolve
					</Button>
				)}
				{!isResolved && (
					<Button
						variant="ghost"
						size="sm"
						onClick={() => updateStatus('dismissed')}
						disabled={busy}
						aria-label="Dismiss"
					>
						<X className="size-3.5 mr-1" />
						Dismiss
					</Button>
				)}
				<Button
					variant="ghost"
					size="sm"
					onClick={onDelete}
					disabled={busy}
					className="text-destructive hover:text-destructive"
					aria-label="Delete"
				>
					Delete
				</Button>
			</div>
		</div>
	)
}

function NotificationDetailView({ notification }: { notification: NotificationResponse }) {
	const callTool = useCallTool()
	const [local, setLocal] = useState(notification)
	const [busy, setBusy] = useState(false)
	const [feedback, setFeedback] = useState<string | null>(null)

	useEffect(() => {
		setLocal(notification)
	}, [notification])

	const updateStatus = useCallback(
		async (status: 'seen' | 'resolved' | 'dismissed' | 'pending') => {
			setBusy(true)
			setFeedback(null)
			const previous = local.status
			setLocal({ ...local, status })
			try {
				await callTool('update_notification', { id: notification.id, status })
				setFeedback(`Marked ${status}`)
			} catch (err) {
				setLocal({ ...local, status: previous })
				setFeedback(`Failed: ${String(err)}`)
			} finally {
				setBusy(false)
			}
		},
		[callTool, local, notification.id],
	)

	const typeLabel = TYPE_LABELS[local.type] ?? local.type

	return (
		<div className="p-4 max-w-2xl space-y-3">
			<div className="flex items-start justify-between gap-3">
				<div className="flex items-center gap-3">
					<NotificationIcon type={local.type} />
					<div>
						<h1 className="text-lg font-semibold text-foreground">{local.title}</h1>
						<div className="flex items-center gap-2 mt-1">
							<span className="text-xs text-muted-foreground">{typeLabel}</span>
							<Badge variant={STATUS_VARIANTS[local.status] ?? 'secondary'}>{local.status}</Badge>
							{local.createdAt && (
								<span className="text-xs text-muted-foreground">
									<RelativeTime date={local.createdAt} />
								</span>
							)}
						</div>
					</div>
				</div>
				{local.objectId ? (
					<WebAppLink target={{ kind: 'object', id: local.objectId }} label="Open object" />
				) : (
					<WebAppLink target={{ kind: 'pulse' }} label="Open Pulse" />
				)}
			</div>

			{local.content && (
				<div className="border-t border-border pt-3">
					<MarkdownContent content={local.content} />
				</div>
			)}

			<div className="flex items-center gap-2 border-t border-border pt-3">
				{local.status === 'pending' && (
					<Button size="sm" variant="outline" onClick={() => updateStatus('seen')} disabled={busy}>
						Mark seen
					</Button>
				)}
				{local.status !== 'resolved' && (
					<Button size="sm" onClick={() => updateStatus('resolved')} disabled={busy}>
						Resolve
					</Button>
				)}
				{local.status !== 'dismissed' && (
					<Button
						size="sm"
						variant="outline"
						onClick={() => updateStatus('dismissed')}
						disabled={busy}
					>
						Dismiss
					</Button>
				)}
			</div>
			{feedback && <p className="text-xs text-muted-foreground">{feedback}</p>}
		</div>
	)
}

function NotificationIcon({ type }: { type: string }) {
	switch (type) {
		case 'needs_input':
			return <MessageSquare className="size-4 text-accent" />
		case 'recommendation':
			return <Bot className="size-4 text-accent" />
		case 'alert':
			return <Bell className="size-4 text-destructive" />
		default:
			return <Bell className="size-4 text-muted-foreground" />
	}
}

function NotificationDeletedView() {
	return (
		<div className="p-4 text-center">
			<p className="text-sm text-muted-foreground">Notification deleted successfully.</p>
		</div>
	)
}

renderMcpApp('Notifications', <NotificationsApp />)
