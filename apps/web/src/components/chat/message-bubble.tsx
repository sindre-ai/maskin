import { ActorAvatar } from '@/components/shared/actor-avatar'
import { AttachedFileCard } from '@/components/shared/attached-file-card'
import { MarkdownContent } from '@/components/shared/markdown-content'
import { ObjectReference } from '@/components/shared/object-reference'
import { RelativeTime } from '@/components/shared/relative-time'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { useEditMessage, useRetryMessage } from '@/hooks/use-conversation'
import type { MessageContextNotification, MessageContextObject, MessageResponse } from '@/lib/api'
import { getStoredActor } from '@/lib/auth'
import { cn } from '@/lib/cn'
import { Bell, Box, Pencil, RotateCcw } from 'lucide-react'
import { useState } from 'react'
import { MessageDivider } from './message-divider'
import { QuestionOptions } from './question-options'

interface MessageBubbleProps {
	workspaceId: string
	message: MessageResponse
	/** The agent's finished chain-of-thought for the turn that produced this
	 *  message, rendered as a muted line under the name (mockup screenshots).
	 *  Only ever present on an agent message. */
	activity?: React.ReactNode
	/** A later message in the thread already answered this message's question. */
	questionAnswered?: boolean
}

/**
 * Renders one thread message. The current actor's own messages render as a
 * right-aligned ink plate (mockup 631–646) with any attached objects lifted
 * out above it under a `YOU ATTACHED` eyebrow; every other participant's
 * message — human or agent — renders left-aligned on the page background
 * (not a card, mockup 648–658) with a `REFERENCED` rail beneath the body.
 */
export function MessageBubble({
	workspaceId,
	message,
	activity,
	questionAnswered = false,
}: MessageBubbleProps) {
	const actor = getStoredActor()
	const isOwn = message.actorId === actor?.id
	// Real, persisted, own message (not a system row, not an optimistic
	// bubble) — the only kind that can be edited or retried.
	const canAct = isOwn && message.id > 0 && message.kind === 'message'
	const [editing, setEditing] = useState(false)
	const [draft, setDraft] = useState('')
	const editMessage = useEditMessage(message.conversationId, workspaceId)
	const retryMessage = useRetryMessage(message.conversationId, workspaceId)
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
		const startEditing = () => {
			setDraft(message.content)
			setEditing(true)
		}
		const saveEdit = () => {
			const content = draft.trim()
			setEditing(false)
			if (content.length === 0 || content === message.content) return
			editMessage.mutate({ messageId: message.id, content })
		}
		return (
			<div className={cn('flex flex-col items-end gap-1.5', editing && 'w-full')}>
				{hasContext ? (
					<div className="flex max-w-[min(560px,80%)] flex-wrap items-center justify-end gap-1.5">
						<span className="eyebrow shrink-0">You attached</span>
						<OwnContextChips objects={contextObjects} notifications={contextNotifications} />
					</div>
				) : null}
				<div
					className={cn(
						'flex max-w-[min(560px,80%)] flex-col gap-1.5 rounded-[16px_16px_5px_16px] bg-primary px-[15px] py-[11px] text-[13.5px] leading-[1.55] text-primary-foreground',
						editing && 'w-full',
					)}
				>
					{fileList}
					{editing ? (
						<div className="flex flex-col gap-2">
							<Textarea
								value={draft}
								onChange={(e) => setDraft(e.target.value)}
								onKeyDown={(e) => {
									if (e.key === 'Enter' && !e.shiftKey) {
										e.preventDefault()
										saveEdit()
									}
									if (e.key === 'Escape') setEditing(false)
								}}
								aria-label="Edit message"
								autoFocus
								className="bg-background text-foreground"
							/>
							<div className="flex justify-end gap-2">
								<Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
									Cancel
								</Button>
								<Button size="sm" onClick={saveEdit}>
									Save
								</Button>
							</div>
						</div>
					) : message.content.length > 0 ? (
						<span className="whitespace-pre-wrap text-balance">{message.content}</span>
					) : null}
				</div>
				{/* The actions sit permanently in the timestamp row rather than
				    revealing on hover — a touch viewport has no hover, and the
				    ship gate asserts plain visibility at 375px. */}
				<div className="flex items-center gap-1">
					{message.editedAt ? (
						<span className="text-[10px] text-muted-foreground">(edited)</span>
					) : null}
					<RelativeTime
						date={message.createdAt}
						format="clock"
						className="text-[10px] text-muted-foreground"
					/>
					{canAct && !editing ? (
						<>
							<button
								type="button"
								onClick={startEditing}
								aria-label="Edit message"
								className="rounded p-1 text-muted-foreground transition-colors hover:text-foreground"
							>
								<Pencil size={12} aria-hidden />
							</button>
							<button
								type="button"
								onClick={() => retryMessage.mutate({ messageId: message.id })}
								disabled={retryMessage.isPending}
								aria-label="Ask agents to respond again"
								className="rounded p-1 text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
							>
								<RotateCcw size={12} aria-hidden />
							</button>
						</>
					) : null}
				</div>
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
						format="clock"
						className="shrink-0 text-[10px] text-muted-foreground"
					/>
				</div>
				{activity ? <div className="mt-0.5">{activity}</div> : null}
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
				{/* An agent's AskUserQuestion, surfaced as pickable options. The
				    message's own content already renders the questions as markdown
				    above, so this adds the affordance rather than the information —
				    which is why it degrades to plain text everywhere else. */}
				{message.metadata?.question ? (
					<QuestionOptions
						conversationId={message.conversationId}
						workspaceId={workspaceId}
						questionMessageId={message.id}
						question={message.metadata.question}
						answered={questionAnswered}
					/>
				) : null}
				{hasContext ? (
					<div className="mt-[7px] flex flex-wrap items-center gap-2 border-t border-border-subtle pt-[7px]">
						<span className="eyebrow shrink-0">Referenced</span>
						{contextObjects.map((o) => (
							<ObjectReference
								key={o.id}
								objectId={o.id}
								workspaceId={workspaceId}
								variant="pill"
							/>
						))}
						{contextNotifications.map((n) => (
							<span
								key={n.id}
								className="inline-flex max-w-full items-center gap-[7px] rounded-[9px] border border-border bg-card py-1 pr-2.5 pl-2 text-[11.5px] text-muted-foreground"
							>
								<Bell size={11} aria-hidden />
								<span className="min-w-0 truncate font-semibold text-foreground">
									{n.title?.trim() || n.id}
								</span>
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
