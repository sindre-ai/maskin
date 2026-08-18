import { ActorAvatar } from '@/components/shared/actor-avatar'
import { AttachedFileCard } from '@/components/shared/attached-file-card'
import { MarkdownContent } from '@/components/shared/markdown-content'
import { ObjectReference } from '@/components/shared/object-reference'
import { RelativeTime } from '@/components/shared/relative-time'
import type { MessageContextNotification, MessageContextObject, MessageResponse } from '@/lib/api'
import { getStoredActor } from '@/lib/auth'
import { Bell, Box } from 'lucide-react'
import { MessageDivider } from './message-divider'

interface MessageBubbleProps {
	workspaceId: string
	message: MessageResponse
}

/**
 * Renders one thread message. The current actor's own messages render as a
 * right-aligned ink plate (mockup 631–646) with any attached objects lifted
 * out above it under a `YOU ATTACHED` eyebrow; every other participant's
 * message — human or agent — renders left-aligned on the page background
 * (not a card, mockup 648–658) with a `REFERENCED` rail beneath the body.
 */
export function MessageBubble({ workspaceId, message }: MessageBubbleProps) {
	const actor = getStoredActor()
	const isOwn = message.actorId === actor?.id
	const attachments = message.metadata?.attachments ?? []
	const contextObjects = message.metadata?.context_objects ?? []
	const contextNotifications = message.metadata?.context_notifications ?? []
	const hasContext = contextObjects.length > 0 || contextNotifications.length > 0

	if (message.kind === 'system') {
		return <MessageDivider label={message.content} />
	}

	const fileList =
		attachments.length > 0 ? (
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
		) : null

	if (isOwn) {
		return (
			<div className="flex flex-col items-end gap-1.5">
				{hasContext ? (
					<div className="flex max-w-[min(560px,80%)] flex-wrap items-center justify-end gap-1.5">
						<span className="eyebrow shrink-0">You attached</span>
						<OwnContextChips objects={contextObjects} notifications={contextNotifications} />
					</div>
				) : null}
				<div className="flex max-w-[min(560px,80%)] flex-col gap-1.5 rounded-[16px_16px_5px_16px] bg-primary px-[15px] py-[11px] text-[13.5px] leading-[1.55] text-primary-foreground">
					{fileList}
					{message.content.length > 0 ? (
						<span className="whitespace-pre-wrap text-balance">{message.content}</span>
					) : null}
				</div>
				<RelativeTime date={message.createdAt} className="text-[10px] text-muted-foreground" />
			</div>
		)
	}

	return (
		<div className="flex items-start gap-[11px]">
			<ActorAvatar
				id={message.actorId}
				name={message.actorName}
				type={message.actorType}
				size="md"
				className="shrink-0 rounded-lg"
			/>
			<div className="min-w-0 flex-1 md:max-w-[660px]">
				<div className="flex items-baseline gap-2">
					<span className="truncate text-[12.5px] font-bold text-foreground">
						{message.actorName}
					</span>
					<RelativeTime
						date={message.createdAt}
						className="shrink-0 text-[10px] text-muted-foreground"
					/>
				</div>
				{fileList ? <div className="mt-1.5">{fileList}</div> : null}
				{message.content.length > 0 ? (
					<div className="mt-1 text-[13.5px] leading-[1.6]">
						{/* `renderVisuals` turns a ```chart fenced block into the bounded
						    data-viz card (mockup 660–679). Agents are told how to emit one
						    in `createCommentSchema`'s content description, and the same
						    parser backs object comments — no new payload, just the render
						    path the chat surface was missing. */}
						<MarkdownContent content={message.content} size="sm" renderVisuals />
					</div>
				) : null}
				{hasContext ? (
					<div className="mt-2 flex flex-wrap items-center gap-x-3.5 gap-y-1.5 border-t border-border pt-2">
						<span className="eyebrow shrink-0">Referenced</span>
						{contextObjects.map((o) => (
							<ObjectReference
								key={o.id}
								objectId={o.id}
								workspaceId={workspaceId}
								className="text-[11.5px]"
							/>
						))}
						{contextNotifications.map((n) => (
							<span
								key={n.id}
								className="inline-flex items-center gap-1.5 text-[11.5px] text-muted-foreground"
							>
								<Bell size={11} aria-hidden />
								<span className="max-w-[12rem] truncate">{n.title?.trim() || n.id}</span>
							</span>
						))}
					</div>
				) : null}
			</div>
		</div>
	)
}

/** The own-message chips sit outside the ink plate, so they use the page
 *  surface rather than an on-plate tint. */
function OwnContextChips({
	objects,
	notifications,
}: {
	objects: MessageContextObject[]
	notifications: MessageContextNotification[]
}) {
	const chipClassName =
		'inline-flex max-w-full items-center gap-1.5 rounded-[9px] border border-border bg-background px-2.5 py-1 text-[11.5px] font-semibold text-foreground'
	return (
		<ul className="flex flex-wrap justify-end gap-1.5" aria-label="Attached context">
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
