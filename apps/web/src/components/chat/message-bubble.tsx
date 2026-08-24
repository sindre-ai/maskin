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
import { Bell, Bot, Box, Pencil, RotateCcw } from 'lucide-react'
import { useState } from 'react'
import { MessageDivider } from './message-divider'

interface MessageBubbleProps {
	workspaceId: string
	message: MessageResponse
	/** actorId -> display name, from the conversation's participant list — used to label `metadata.mentions`. */
	participantNames?: Map<string, string>
	/**
	 * Read from the live session log rather than the messages table — an
	 * agent's end-of-turn output shown in the seconds before the backend's
	 * persisted row arrives. Same box model as a real bubble so the swap
	 * causes no layout shift; a dashed rule and a status line in place of
	 * the timestamp mark it as not-yet-saved.
	 */
	pending?: boolean
	/** With `pending`: the persisted row is overdue, so say it isn't saved. */
	unconfirmed?: boolean
	/** With `pending`: the turn ended in an error result — tint accordingly. */
	isError?: boolean
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
	participantNames,
	pending,
	unconfirmed,
	isError,
}: MessageBubbleProps) {
	const actor = getStoredActor()
	const isOwn = message.actorId === actor?.id
	// Real, persisted, own message (not a system row, not an optimistic or
	// synthetic bubble) — the only kind that can be edited or retried.
	const canAct = isOwn && !pending && message.id > 0 && message.kind === 'message'
	const [editing, setEditing] = useState(false)
	const [draft, setDraft] = useState('')
	const editMessage = useEditMessage(message.conversationId, workspaceId)
	const retryMessage = useRetryMessage(message.conversationId, workspaceId)
	// An agent's auto-posted end-of-turn reply carries the id of the chat
	// message whose turn produced it — that's the message to re-run when the
	// user wants the agent to redo this response ("regenerate").
	const finalOutputMessageId = message.metadata?.final_output?.message_id
	const redoMessageId =
		!isOwn &&
		!pending &&
		message.id > 0 &&
		message.metadata?.source === 'final_output' &&
		typeof finalOutputMessageId === 'number'
			? finalOutputMessageId
			: null
	const attachments = message.metadata?.attachments ?? []
	const contextObjects = message.metadata?.context_objects ?? []
	const contextNotifications = message.metadata?.context_notifications ?? []
	const mentions = message.metadata?.mentions ?? []
	const hasContext =
		contextObjects.length > 0 || contextNotifications.length > 0 || mentions.length > 0

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
			<div className="flex flex-col items-end gap-1.5">
				{hasContext ? (
					<div className="flex max-w-[min(560px,80%)] flex-wrap items-center justify-end gap-1.5">
						<span className="eyebrow shrink-0">You attached</span>
						<OwnContextChips
							objects={contextObjects}
							notifications={contextNotifications}
							mentions={mentions}
							participantNames={participantNames}
						/>
					</div>
				) : null}
				<div
					className={cn(
						'flex flex-col gap-1.5 rounded-[16px_16px_5px_16px] bg-primary px-[15px] py-[11px] text-[13.5px] leading-[1.55] text-primary-foreground',
						editing ? 'w-full' : 'max-w-[min(560px,80%)]',
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
				<div className="flex items-center gap-1">
					{message.editedAt ? (
						<span className="text-[10px] text-muted-foreground">(edited)</span>
					) : null}
					<RelativeTime date={message.createdAt} className="text-[10px] text-muted-foreground" />
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
					{pending ? (
						<span className="shrink-0 text-[10px] text-muted-foreground">
							{unconfirmed ? 'Not saved yet' : 'Finishing up…'}
						</span>
					) : (
						<>
							<RelativeTime
								date={message.createdAt}
								className="shrink-0 text-[10px] text-muted-foreground"
							/>
							{message.editedAt ? (
								<span className="shrink-0 text-[10px] text-muted-foreground">(edited)</span>
							) : null}
						</>
					)}
				</div>
				{fileList ? <div className="mt-1.5">{fileList}</div> : null}
				{message.content.length > 0 ? (
					<div
						className={cn(
							'mt-1 text-[13.5px] leading-[1.6]',
							// A not-yet-persisted end-of-turn reply keeps the same box
							// model, marked out by a dashed rule rather than a card.
							pending && 'rounded-md border border-dashed border-border px-3 py-2',
							pending && isError && 'border-error text-error',
						)}
					>
						{/* `renderVisuals` turns a fenced ```chart block into the bounded
						    data-viz card (mockup 660–679). Agents are told how to emit one
						    in `createCommentSchema`'s content description, and the same
						    parser backs object comments — no new payload, just the render
						    path the chat surface was missing. */}
						<MarkdownContent content={message.content} size="sm" renderVisuals />
					</div>
				) : null}
				{redoMessageId !== null ? (
					<button
						type="button"
						onClick={() =>
							retryMessage.mutate({ messageId: redoMessageId, agentId: message.actorId })
						}
						disabled={retryMessage.isPending}
						aria-label="Redo this response"
						className="mt-1 flex w-fit items-center gap-1 rounded p-0.5 text-[11px] text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
					>
						<RotateCcw size={11} aria-hidden />
						Redo
					</button>
				) : null}
				{hasContext ? (
					<div className="mt-2 flex flex-wrap items-center gap-x-3.5 gap-y-1.5 border-t border-border pt-2">
						<span className="eyebrow shrink-0">Referenced</span>
						{mentions.map((actorId) => (
							<span
								key={actorId}
								className="inline-flex items-center gap-1.5 text-[11.5px] text-muted-foreground"
							>
								<Bot size={11} aria-hidden />
								<span className="max-w-[12rem] truncate">
									@{participantNames?.get(actorId)?.trim() || actorId}
								</span>
							</span>
						))}
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
	mentions,
	participantNames,
}: {
	objects: MessageContextObject[]
	notifications: MessageContextNotification[]
	mentions: string[]
	participantNames?: Map<string, string>
}) {
	const chipClassName =
		'inline-flex max-w-full items-center gap-1.5 rounded-[9px] border border-border bg-background px-2.5 py-1 text-[11.5px] font-semibold text-foreground'
	return (
		<ul className="flex flex-wrap justify-end gap-1.5" aria-label="Attached context">
			{mentions.map((actorId) => (
				<li key={actorId} className={chipClassName}>
					<Bot size={11} aria-hidden />
					<span className="max-w-[12rem] truncate">
						@{participantNames?.get(actorId)?.trim() || actorId}
					</span>
				</li>
			))}
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
