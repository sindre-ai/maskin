import { ActorAvatar } from '@/components/shared/actor-avatar'
import { AttachedFileCard } from '@/components/shared/attached-file-card'
import { MarkdownContent } from '@/components/shared/markdown-content'
import { RelativeTime } from '@/components/shared/relative-time'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { useEditMessage, useRetryMessage } from '@/hooks/use-conversation'
import type { MessageContextNotification, MessageContextObject, MessageResponse } from '@/lib/api'
import { getStoredActor } from '@/lib/auth'
import { cn } from '@/lib/cn'
import { Bell, Bot, Box, Pencil, RotateCcw } from 'lucide-react'
import { useState } from 'react'

interface MessageBubbleProps {
	workspaceId: string
	message: MessageResponse
	/** actorId -> display name, from the conversation's participant list — used to label `metadata.mentions`. */
	participantNames?: Map<string, string>
	/**
	 * Read from the live session log rather than the messages table — an
	 * agent's end-of-turn output shown in the seconds before the backend's
	 * persisted row arrives. Same box model as a real bubble so the swap
	 * causes no layout shift; a dashed border and a status line in place of
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
 * right-aligned bubble (near-direct lift of chat-transcript.tsx's
 * UserMessageBlock); every other participant's message — human or agent —
 * renders left-aligned with an avatar + name label, since a multi-party
 * conversation can't assume "the other side" is always the same speaker.
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
		return (
			<div className="flex justify-center py-1">
				<span className="rounded-full bg-bg-surface px-3 py-1 text-xs text-muted-foreground">
					{message.content}
				</span>
			</div>
		)
	}

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
			<div className="flex justify-end">
				<div className={cn('flex max-w-[85%] flex-col gap-1', editing && 'w-full')}>
					<div className="flex flex-col gap-1 rounded-md bg-accent px-3 py-2 text-accent-foreground text-sm">
						{hasContext ? (
							<MessageContextChips
								objects={contextObjects}
								notifications={contextNotifications}
								mentions={mentions}
								participantNames={participantNames}
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
									className="bg-bg text-foreground"
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
							<span className="whitespace-pre-wrap">{message.content}</span>
						) : null}
					</div>
					<div className="flex items-center justify-end gap-1">
						{message.editedAt ? (
							<span className="text-[11px] text-muted-foreground">(edited)</span>
						) : null}
						<RelativeTime date={message.createdAt} className="text-[11px] text-muted-foreground" />
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
					{pending ? (
						<span className="shrink-0 text-[11px] text-muted-foreground">
							{unconfirmed ? 'Not saved yet' : 'Finishing up…'}
						</span>
					) : (
						<>
							<RelativeTime
								date={message.createdAt}
								className="shrink-0 text-[11px] text-muted-foreground"
							/>
							{message.editedAt ? (
								<span className="shrink-0 text-[11px] text-muted-foreground">(edited)</span>
							) : null}
						</>
					)}
				</div>
				<div
					className={cn(
						'flex flex-col gap-1 rounded-md border border-border bg-bg-surface px-3 py-2 text-sm',
						pending && 'border-dashed',
						pending && isError && 'border-error text-error',
					)}
				>
					{hasContext ? (
						<MessageContextChips
							objects={contextObjects}
							notifications={contextNotifications}
							mentions={mentions}
							participantNames={participantNames}
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
				{redoMessageId !== null ? (
					<button
						type="button"
						onClick={() =>
							retryMessage.mutate({ messageId: redoMessageId, agentId: message.actorId })
						}
						disabled={retryMessage.isPending}
						aria-label="Redo this response"
						className="flex w-fit items-center gap-1 rounded p-0.5 text-[11px] text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
					>
						<RotateCcw size={11} aria-hidden />
						Redo
					</button>
				) : null}
			</div>
		</div>
	)
}

interface MessageContextChipsProps {
	objects: MessageContextObject[]
	notifications: MessageContextNotification[]
	mentions: string[]
	participantNames?: Map<string, string>
	/** "own" sits on the accent bubble background, "other" sits on bg-surface. */
	variant: 'own' | 'other'
}

/** Renders attached context objects/notifications/@mentions as a row of pill chips above the message text, instead of the raw "Context objects: — id: ..." text block the composer used to inline into content. */
function MessageContextChips({
	objects,
	notifications,
	mentions,
	participantNames,
	variant,
}: MessageContextChipsProps) {
	const chipClassName =
		variant === 'own'
			? 'inline-flex max-w-full items-center gap-1 rounded-full bg-accent-foreground/15 px-2 py-0.5 text-[11px]'
			: 'inline-flex max-w-full items-center gap-1 rounded-full border border-border bg-bg px-2 py-0.5 text-[11px] text-foreground'

	return (
		<ul className="flex flex-wrap gap-1" aria-label="Attached context">
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
