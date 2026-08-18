import { ActorAvatar } from '@/components/shared/actor-avatar'
import { AttachedFileCard } from '@/components/shared/attached-file-card'
import { MarkdownContent } from '@/components/shared/markdown-content'
import { RelativeTime } from '@/components/shared/relative-time'
import type { MessageContextNotification, MessageContextObject, MessageResponse } from '@/lib/api'
import { getStoredActor } from '@/lib/auth'
import { cn } from '@/lib/cn'
import { Bell, Box } from 'lucide-react'

interface MessageBubbleProps {
	workspaceId: string
	message: MessageResponse
}

/**
 * Renders one thread message. The current actor's own messages render as a
 * right-aligned bubble (near-direct lift of chat-transcript.tsx's
 * UserMessageBlock); every other participant's message — human or agent —
 * renders left-aligned with an avatar + name label, since a multi-party
 * conversation can't assume "the other side" is always the same speaker.
 */
export function MessageBubble({ workspaceId, message }: MessageBubbleProps) {
	const actor = getStoredActor()
	const isOwn = message.actorId === actor?.id
	const attachments = message.metadata?.attachments ?? []
	const contextObjects = message.metadata?.context_objects ?? []
	const contextNotifications = message.metadata?.context_notifications ?? []
	const hasContext = contextObjects.length > 0 || contextNotifications.length > 0

	if (message.kind === 'system') {
		return (
			<div className="flex justify-center py-1">
				<span className="rounded-full bg-bg-surface px-3 py-1 text-xs text-muted-foreground">
					{message.content}
				</span>
			</div>
		)
	}

	if (isOwn) {
		return (
			<div className="flex justify-end">
				<div className="flex max-w-[85%] flex-col gap-1">
					<div className="flex flex-col gap-1 rounded-md bg-accent px-3 py-2 text-accent-foreground text-sm">
						{hasContext ? (
							<MessageContextChips
								objects={contextObjects}
								notifications={contextNotifications}
								variant="own"
							/>
						) : null}
						{attachments.length > 0 ? (
							<ul className="flex flex-col gap-1" aria-label="Attached files">
								{attachments.map((f) => (
									<li key={f.file_id}>
										<AttachedFileCard
											workspaceId={workspaceId}
											file={{
												id: f.file_id,
												name: f.name ?? 'Attachment',
												sizeBytes: f.size_bytes ?? 0,
												mimeType: f.mime_type,
											}}
										/>
									</li>
								))}
							</ul>
						) : null}
						{message.content.length > 0 ? (
							<span className="whitespace-pre-wrap">{message.content}</span>
						) : null}
					</div>
					<RelativeTime
						date={message.createdAt}
						className="self-end text-[11px] text-muted-foreground"
					/>
				</div>
			</div>
		)
	}

	return (
		<div className="flex items-start gap-2">
			<ActorAvatar
				id={message.actorId}
				name={message.actorName}
				type={message.actorType}
				size="sm"
				className="mt-0.5 shrink-0"
			/>
			<div className="flex min-w-0 max-w-[85%] flex-col gap-1">
				<div className="flex items-baseline gap-2">
					<span className="truncate text-xs font-medium text-foreground">{message.actorName}</span>
					<RelativeTime
						date={message.createdAt}
						className="shrink-0 text-[11px] text-muted-foreground"
					/>
				</div>
				<div
					className={cn(
						'flex flex-col gap-1 rounded-md border border-border bg-bg-surface px-3 py-2 text-sm',
					)}
				>
					{hasContext ? (
						<MessageContextChips
							objects={contextObjects}
							notifications={contextNotifications}
							variant="other"
						/>
					) : null}
					{attachments.length > 0 ? (
						<ul className="flex flex-col gap-1" aria-label="Attached files">
							{attachments.map((f) => (
								<li key={f.file_id}>
									<AttachedFileCard
										workspaceId={workspaceId}
										file={{
											id: f.file_id,
											name: f.name ?? 'Attachment',
											sizeBytes: f.size_bytes ?? 0,
											mimeType: f.mime_type,
										}}
									/>
								</li>
							))}
						</ul>
					) : null}
					{message.content.length > 0 ? (
						<MarkdownContent content={message.content} size="sm" />
					) : null}
				</div>
			</div>
		</div>
	)
}

interface MessageContextChipsProps {
	objects: MessageContextObject[]
	notifications: MessageContextNotification[]
	/** "own" sits on the accent bubble background, "other" sits on bg-surface. */
	variant: 'own' | 'other'
}

/** Renders attached context objects/notifications as a row of pill chips above the message text, instead of the raw "Context objects: — id: ..." text block the composer used to inline into content. */
function MessageContextChips({ objects, notifications, variant }: MessageContextChipsProps) {
	const chipClassName =
		variant === 'own'
			? 'inline-flex max-w-full items-center gap-1 rounded-full bg-accent-foreground/15 px-2 py-0.5 text-[11px]'
			: 'inline-flex max-w-full items-center gap-1 rounded-full border border-border bg-bg px-2 py-0.5 text-[11px] text-foreground'

	return (
		<ul className="flex flex-wrap gap-1" aria-label="Attached context">
			{objects.map((o) => (
				<li key={o.id} className={chipClassName}>
					<Box size={11} aria-hidden />
					<span className="max-w-[12rem] truncate">{o.title?.trim() || o.id}</span>
				</li>
			))}
			{notifications.map((n) => (
				<li key={n.id} className={chipClassName}>
					<Bell size={11} aria-hidden />
					<span className="max-w-[12rem] truncate">{n.title?.trim() || n.id}</span>
				</li>
			))}
		</ul>
	)
}
