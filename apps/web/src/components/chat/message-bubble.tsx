import {
	renderLinkedCard,
	renderLinkedChip,
	renderLinkedGithubChip,
} from '@/components/chat/linked-object-preview'
import {
	OtherWorkspaceLink,
	useOtherWorkspaceLabel,
} from '@/components/chat/linked-object-reference'
import { ActorAvatar } from '@/components/shared/actor-avatar'
import { AttachedFileCard } from '@/components/shared/attached-file-card'
import { MarkdownContent } from '@/components/shared/markdown-content'
import { ObjectReference } from '@/components/shared/object-reference'
import { RelativeTime } from '@/components/shared/relative-time'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { useActors } from '@/hooks/use-actors'
import { useEditMessage, useRetryMessage } from '@/hooks/use-conversation'
import { useFeatureFlag } from '@/hooks/use-feature-flag'
import { useFiles } from '@/hooks/use-files'
import { useLinkedChat } from '@/hooks/use-linked-chat'
import { useLoop } from '@/hooks/use-loops'
import { useObject } from '@/hooks/use-objects'
import { useTrigger } from '@/hooks/use-triggers'
import type { MessageContextNotification, MessageContextObject, MessageResponse } from '@/lib/api'
import { getStoredActor } from '@/lib/auth'
import { cn } from '@/lib/cn'
import {
	type GithubTarget,
	githubChipName,
	githubChipText,
	splitOwnLinks,
} from '@/lib/linked-objects'
import { Link } from '@tanstack/react-router'
import {
	ArrowUpRight,
	Bell,
	Box,
	CircleDot,
	Copy,
	GitPullRequest,
	Globe,
	Link2,
	MessageSquareReply,
	Pencil,
	RotateCcw,
} from 'lucide-react'
import { Fragment, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { ComputerRequestCard } from './computer-request-card'
import { HandedOffStrip } from './handed-off-strip'
import { HandoffCard } from './handoff-card'
import { IntegrationAccessRequestCard } from './integration-access-request-card'
import { IntegrationConnectCard } from './integration-connect-card'
import { KeychainAccessRequestCard } from './keychain-access-request-card'
import { KeychainRequestCard } from './keychain-request-card'
import { McpServerRequestCard } from './mcp-server-request-card'
import { type MessageAttachmentItem, MessageAttachments } from './message-attachments'
import { MessageDivider } from './message-divider'
import { QuestionOptions } from './question-options'
import { type MessageSpawnInfo, SpawnBar, SpawnChip } from './spawn-indicator'
import { useThreadsPane } from './threads-context'
import { VoiceMessageMetaTag } from './voice-call-boundary'

function copyMessage(content: string) {
	void navigator.clipboard?.writeText(content).then(
		() => toast.success('Copied to clipboard'),
		() => toast.error('Copy failed'),
	)
}

interface MessageBubbleProps {
	workspaceId: string
	message: MessageResponse
	/** The agent's finished chain-of-thought for the turn that produced this
	 *  message, rendered as a muted line under the name (mockup screenshots).
	 *  Only ever present on an agent message. */
	activity?: React.ReactNode
	/** A later message in the thread already answered this message's question. */
	questionAnswered?: boolean
	/** S2 · bet 34706e2f, task 5. When set, this message spawned an agent
	 *  session — render the persistent vertical --brand bar to the bubble's
	 *  right and the spawn chip below it. */
	spawnInfo?: MessageSpawnInfo
	/** Linked objects another message in the chat holds the card for: they are chips here. */
	shownLinkedObjectIds?: ReadonlySet<string>
	/** Linked drafts edited since an earlier message showed them: their card here is tagged Updated. */
	updatedLinkedObjectIds?: ReadonlySet<string>
	/** Called once a redo of this message has been accepted, so the thread can drop the failed reply it replaces. */
	onRetried?: (message: MessageResponse) => void
	/** Opens the reply thread under this message. Without it the bubble has no Reply action. */
	onReplyInThread?: () => void
}

// Same raw-button pattern as Copy, but padded to a 32px target on phones and wherever any
// coarse pointer exists (an iPad with a trackpad reports a fine primary pointer).
const REPLY_BUTTON_CLASS =
	'rounded p-2.5 text-muted-foreground transition-colors hover:text-foreground md:p-1 any-pointer-coarse:p-2.5'

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
	spawnInfo,
	shownLinkedObjectIds,
	updatedLinkedObjectIds,
	onRetried,
	onReplyInThread,
}: MessageBubbleProps) {
	const actor = getStoredActor()
	const isOwn = message.actorId === actor?.id
	// Present only under the chat route, which owns the Threads pane. Without
	// it the handoff falls back to the strip, whose rows link out instead.
	const threadsPane = useThreadsPane()
	const { data: workspaceActors } = useActors(workspaceId, { enabled: true })
	const actorLookup = useMemo(() => {
		const map = new Map<string, { id: string; name: string; type: string }>()
		for (const a of workspaceActors ?? []) map.set(a.id, { id: a.id, name: a.name, type: a.type })
		return map
	}, [workspaceActors])
	// Real, persisted, own message (not a system row, not an optimistic
	// bubble) — the only kind that can be edited or retried.
	const canAct = isOwn && message.id > 0 && message.kind === 'message'
	// Any real, persisted message with text can be copied, own or not.
	const canCopy = message.id > 0 && message.kind === 'message' && message.content.length > 0
	const canReply = !!onReplyInThread && message.id > 0 && message.kind === 'message'
	const [editing, setEditing] = useState(false)
	const [draft, setDraft] = useState('')
	const editMessage = useEditMessage(message.conversationId, workspaceId)
	const retryMessage = useRetryMessage(message.conversationId, workspaceId)
	// The one read of this flag: files and images lift out of the text bubble when it is on.
	const attachmentsLifted = useFeatureFlag('chat-attachments-lifted')
	const attachments = message.metadata?.attachments ?? []
	// Resolve the file record for each attachment so the bubble renders the real
	// filename — the metadata `name` is best-effort and older / MCP-posted
	// messages often omit it, which previously fell through to a hardcoded
	// "Attachment" label. Matches the right sidebar's file rendering.
	const attachmentFileIds = useMemo(() => attachments.map((a) => a.file_id), [attachments])
	const { data: attachedFiles } = useFiles(workspaceId, { ids: attachmentFileIds })
	const filesById = useMemo(
		() => new Map((attachedFiles ?? []).map((f) => [f.id, f])),
		[attachedFiles],
	)
	const contextObjects = message.metadata?.context_objects ?? []
	const contextNotifications = message.metadata?.context_notifications ?? []
	const mentions = message.metadata?.mentions ?? []
	const hasContext = contextObjects.length > 0 || contextNotifications.length > 0
	const hasMentions = mentions.length > 0
	const isVoice = message.metadata?.source === 'voice'
	// Links to objects and files in your own message are drawn inline as chips with the thing's
	// name. Only your own words: another author's links are handled by `linkedCards` on their markdown.
	// A tapped answer reaches the agent with its question for context; the person's own bubble
	// shows only what they picked (one question: just the pick, several: header and pick).
	const answers = message.metadata?.question_answer?.answers
	const shownContent =
		isOwn && answers && answers.length > 0 && message.content.startsWith('**')
			? answers
					.map((a) => (answers.length > 1 ? `${a.header}: ` : '') + a.selected.join(', '))
					.join('\n')
			: message.content
	const ownSegments = useMemo(
		() => (isOwn ? splitOwnLinks(shownContent, workspaceId) : []),
		[isOwn, shownContent, workspaceId],
	)

	if (message.kind === 'system') {
		return <MessageDivider label={message.content} />
	}

	const liftedAttachments =
		attachmentsLifted && attachments.length > 0 ? (
			<MessageAttachments
				workspaceId={workspaceId}
				align={isOwn ? 'end' : 'start'}
				items={attachments.map((f): MessageAttachmentItem => {
					const resolved = filesById.get(f.file_id)
					return {
						id: f.file_id,
						name: resolved?.name ?? f.name ?? 'Attachment',
						sizeBytes: resolved?.sizeBytes ?? f.size_bytes ?? 0,
						mimeType: resolved?.mimeType ?? f.mime_type,
						// The file list has loaded and this file is not in it: it was deleted.
						status: attachedFiles && !resolved ? 'gone' : undefined,
					}
				})}
			/>
		) : null

	const fileList =
		!attachmentsLifted && attachments.length > 0 ? (
			<ul className="flex flex-col gap-1" aria-label="Attached files">
				{attachments.map((f) => {
					const resolved = filesById.get(f.file_id)
					return (
						<li key={f.file_id}>
							<AttachedFileCard
								workspaceId={workspaceId}
								file={{
									id: f.file_id,
									name: resolved?.name ?? f.name ?? 'Attachment',
									sizeBytes: resolved?.sizeBytes ?? f.size_bytes ?? 0,
									mimeType: resolved?.mimeType ?? f.mime_type,
								}}
							/>
						</li>
					)
				})}
			</ul>
		) : null

	if (isOwn) {
		// A message that is only attachments has no bubble.
		const hasPlate = !attachmentsLifted || editing || message.content.length > 0
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
			<div
				className={cn(
					'flex flex-col items-end',
					// Lifted attachments stack 4px above the text bubble.
					attachmentsLifted ? 'gap-1' : 'gap-1.5',
					editing && 'w-full',
				)}
			>
				{hasContext ? (
					<div className="flex max-w-[min(560px,80%)] flex-wrap items-center justify-end gap-1.5">
						<span className="eyebrow shrink-0">YOU ATTACHED</span>
						<OwnContextChips objects={contextObjects} notifications={contextNotifications} />
					</div>
				) : null}
				{hasMentions ? (
					<div className="flex max-w-[min(560px,80%)] flex-wrap items-center justify-end gap-1.5">
						<span className="eyebrow shrink-0">You mentioned</span>
						<MentionPills
							mentions={mentions}
							workspaceId={workspaceId}
							actorLookup={actorLookup}
							selfActorId={actor?.id ?? null}
						/>
					</div>
				) : null}
				{liftedAttachments}
				{hasPlate ? (
					<>
						{/* S2 · persistent spawn marker. The wrapper reserves the bar's gutter
				    (`pr-2`) and owns the absolute placement, so the bar sits flush
				    against the bubble and stays inside the box that measures overflow. */}
						<div
							className={cn(
								'relative max-w-[min(560px,80%)]',
								spawnInfo && 'pr-2',
								editing && 'w-full',
							)}
						>
							{spawnInfo ? <SpawnBar className="absolute right-0 top-0 h-full" /> : null}
							<div className="flex flex-col gap-1.5 rounded-[16px_16px_5px_16px] bg-primary px-[15px] py-[11px] text-[13.5px] leading-[1.55] text-primary-foreground">
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
												if (e.key === 'Escape') {
													e.preventDefault()
													setEditing(false)
												}
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
									// `break-words` is load-bearing next to the column's `min-w-0`:
									// `min-w-0` bounds the box, this bounds the ink. Without it an
									// unbroken token (a long URL) raises this span's min-content and
									// paints past the bubble's `max-w` cap, out to the viewport edge.
									<span className="whitespace-pre-wrap text-balance break-words">
										{ownSegments.map((segment, index) =>
											segment.kind === 'text' ? (
												// biome-ignore lint/suspicious/noArrayIndexKey: segments are positional by construction
												<Fragment key={index}>{segment.text}</Fragment>
											) : (
												<OwnLinkChip
													// biome-ignore lint/suspicious/noArrayIndexKey: the same link can appear twice
													key={index}
													workspaceId={workspaceId}
													segment={segment}
												/>
											),
										)}
									</span>
								) : null}
							</div>
						</div>
					</>
				) : null}
				{spawnInfo ? <SpawnChip info={spawnInfo} /> : null}
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
					{isVoice ? <VoiceMessageMetaTag /> : null}
					{canCopy && !editing ? (
						<button
							type="button"
							onClick={() => copyMessage(message.content)}
							aria-label="Copy message"
							className="rounded p-1 text-muted-foreground transition-colors hover:text-foreground"
						>
							<Copy size={12} aria-hidden />
						</button>
					) : null}
					{canReply && !editing ? (
						<button
							type="button"
							onClick={onReplyInThread}
							aria-label="Reply in thread"
							className={REPLY_BUTTON_CLASS}
						>
							<MessageSquareReply size={12} aria-hidden />
						</button>
					) : null}
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
								onClick={() =>
									retryMessage.mutate(
										{ messageId: message.id },
										{ onSuccess: () => onRetried?.(message) },
									)
								}
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

	// Optimistic bubbles (id ≤ 0) get no action row. Copy is always available;
	// Retry only applies to a persisted agent message.
	const canRetryAgent = message.id > 0 && message.kind === 'message'
	return (
		<div className="group flex items-start gap-[11px]">
			<ActorAvatar
				id={message.actorId}
				name={message.actorName}
				type={message.actorType}
				size="md"
				className="shrink-0 rounded-lg"
			/>
			<div className={cn('relative min-w-0 flex-1 md:max-w-[660px]', spawnInfo && 'pr-2')}>
				{spawnInfo ? (
					// S2 · agent-side messages can also spawn sessions (an agent that
					// hands off work to a spawned session); render the same marker
					// they'd see on their own bubble. Absolute-positioned in a gutter
					// the column reserves, so it stays inside the column's box.
					<SpawnBar className="absolute right-0 top-0 h-full" />
				) : null}
				<div className="flex items-baseline gap-2">
					<span className="truncate text-[12.5px] font-bold text-foreground">
						{message.actorName}
					</span>
					<RelativeTime
						date={message.createdAt}
						format="clock"
						className="shrink-0 text-[10px] text-muted-foreground"
					/>
					{isVoice ? <VoiceMessageMetaTag /> : null}
				</div>
				{activity ? <div className="mt-0.5">{activity}</div> : null}
				{(liftedAttachments ?? fileList) ? (
					<div className="mt-1.5">{liftedAttachments ?? fileList}</div>
				) : null}
				{message.content.length > 0 ? (
					<div className="mt-1 text-[13.5px] leading-[1.6]">
						{/* `renderVisuals` turns a ```chart fenced block into the bounded
						    data-viz card (mockup 660–679). Agents are told how to emit one
						    in `createCommentSchema`'s content description, and the same
						    parser backs object comments — no new payload, just the render
						    path the chat surface was missing. `linkedCards` draws a link on its own
						    line as a card where it stands (a draft can be approved without leaving
						    the chat) and a link in a sentence as a chip; an id another message holds
						    the card for is a chip here, and a revised draft's card is tagged Updated. */}
						<MarkdownContent
							content={message.content}
							size="sm"
							renderVisuals
							linkedCards={{
								workspaceId,
								conversationId: message.conversationId,
								agentId: message.actorId,
								skipIds: shownLinkedObjectIds,
								updatedIds: updatedLinkedObjectIds,
								renderCard: renderLinkedCard,
								renderChip: renderLinkedChip,
								renderGithubChip: renderLinkedGithubChip,
							}}
						/>
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
				{/* An agent's connect_integration call, surfaced as a Connect card. Like
				    the question chips, the message's markdown already says what to
				    connect; the card adds the button / key input. */}
				{message.metadata?.integration_connect ? (
					<IntegrationConnectCard
						workspaceId={workspaceId}
						conversationId={message.conversationId}
						provider={message.metadata.integration_connect.provider}
					/>
				) : null}
				{/* An agent's request_keychain_credential call, surfaced as a Keychain card.
				    The person types the credential into the card; it never reaches the agent. */}
				{message.metadata?.keychain_request ? (
					<KeychainRequestCard
						workspaceId={workspaceId}
						conversationId={message.conversationId}
						messageCreatedAt={message.createdAt}
						askingAgentId={message.actorId}
						request={message.metadata.keychain_request}
					/>
				) : null}
				{/* An agent's request_keychain_access call: Allow / Not now for a credential that
				    already exists. Allowing grants the agent access on the server. */}
				{message.metadata?.keychain_access_request ? (
					<KeychainAccessRequestCard
						workspaceId={workspaceId}
						conversationId={message.conversationId}
						messageId={message.id}
						askingAgentId={message.actorId}
						request={message.metadata.keychain_access_request}
					/>
				) : null}
				{/* An agent's request_integration_access call: Allow / Not now for an integration that is
				    connected but not allowed for it. Allowing sets its access on the server. */}
				{message.metadata?.integration_access_request ? (
					<IntegrationAccessRequestCard
						workspaceId={workspaceId}
						conversationId={message.conversationId}
						messageId={message.id}
						askingAgentId={message.actorId}
						request={message.metadata.integration_access_request}
					/>
				) : null}
				{/* An agent's add_mcp_server call: the server's details ready to Add, with an input for
				    each secret. Adding it saves the server and gives it to the agent on the server. */}
				{message.metadata?.mcp_server_request ? (
					<McpServerRequestCard
						workspaceId={workspaceId}
						conversationId={message.conversationId}
						messageId={message.id}
						messageCreatedAt={message.createdAt}
						askingAgentId={message.actorId}
						request={message.metadata.mcp_server_request}
					/>
				) : null}
				{/* An agent's show_computer call: a card that opens the agent's own computer so
				    the person can act on it, then hands control back with Done. */}
				{message.metadata?.computer_request ? (
					<ComputerRequestCard
						workspaceId={workspaceId}
						conversationId={message.conversationId}
						messageId={message.id}
						agentId={message.actorId}
						agentName={message.actorName}
						request={message.metadata.computer_request}
					/>
				) : null}
				{/* Chat thread `HANDED OFF` sub-agent delegation strip
				    (bet/444b-handed-off-strip). Renders inside the agent branch under
				    the message text and above the REFERENCED rail — the spec's
				    `When to render` position. HandedOffStrip itself no-ops when the
				    embed is empty, so this is safe on non-spawning agent messages too. */}
				{message.spawned_sessions && message.spawned_sessions.length > 0 ? (
					// With the Threads pane available, ThreadMessages draws each handoff as
					// its own card in the timeline; the strip is the fallback without it.
					threadsPane ? null : (
						<HandedOffStrip
							workspaceId={workspaceId}
							messageId={message.id}
							spawnedSessions={message.spawned_sessions}
						/>
					)
				) : null}
				{hasMentions ? (
					<div className="mt-[7px] flex flex-wrap items-center gap-2">
						<span className="eyebrow shrink-0">Mentioned</span>
						<MentionPills
							mentions={mentions}
							workspaceId={workspaceId}
							actorLookup={actorLookup}
							selfActorId={actor?.id ?? null}
						/>
					</div>
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
				{spawnInfo ? <SpawnChip info={spawnInfo} className="mt-1.5" /> : null}
				{canCopy || canReply ? (
					<div
						className="mt-1.5 flex items-center gap-1 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100 pointer-coarse:opacity-100 any-pointer-coarse:opacity-100"
						aria-label="Message actions"
					>
						{canCopy ? (
							<button
								type="button"
								onClick={() => copyMessage(message.content)}
								aria-label="Copy message"
								className="rounded p-1 text-muted-foreground transition-colors hover:text-foreground"
							>
								<Copy size={12} aria-hidden />
							</button>
						) : null}
						{canReply ? (
							<button
								type="button"
								onClick={onReplyInThread}
								aria-label="Reply in thread"
								className={REPLY_BUTTON_CLASS}
							>
								<MessageSquareReply size={12} aria-hidden />
							</button>
						) : null}
						{canRetryAgent ? (
							<button
								type="button"
								onClick={() =>
									retryMessage.mutate(
										{ messageId: message.id },
										{ onSuccess: () => onRetried?.(message) },
									)
								}
								disabled={retryMessage.isPending}
								aria-label="Retry"
								className="rounded p-1 text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
							>
								<RotateCcw size={12} aria-hidden />
							</button>
						) : null}
					</div>
				) : null}
			</div>
		</div>
	)
}

const MAX_CHIP_TITLE = 30

function chipTitle(title: string): string {
	const trimmed = title.trim()
	return trimmed.length > MAX_CHIP_TITLE
		? `${trimmed.slice(0, MAX_CHIP_TITLE).trimEnd()}…`
		: trimmed
}

const OWN_CHIP_CLASS =
	'inline-flex max-w-full items-center gap-1 rounded-md bg-primary-foreground/15 px-1.5 py-0.5 align-baseline font-medium text-primary-foreground transition-colors hover:bg-primary-foreground/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'

/**
 * A link to an object, file, loop or trigger in your own message, drawn inline where it was typed
 * as a chip with the thing's name (cut at 30 characters; the full name is the tooltip). Until the
 * name is known the chip says what kind of thing it is, so the link never reads as an address.
 * A link into another workspace is a dashed globe chip naming the kind and that workspace instead.
 */
function OwnLinkChip({
	workspaceId,
	segment,
}: {
	workspaceId: string
	segment:
		| { kind: 'loop'; id: string; otherWorkspaceId?: string }
		| { kind: 'trigger'; id: string; otherWorkspaceId?: string }
		| { kind: 'agent'; id: string; otherWorkspaceId?: string }
		| { kind: 'chat'; id: string; otherWorkspaceId?: string }
		| { kind: 'object' | 'file'; id: string; otherWorkspaceId?: string }
		| { kind: 'github'; href: string; target: GithubTarget }
}) {
	if (segment.kind === 'github') {
		return <OwnGithubChip href={segment.href} target={segment.target} />
	}
	if (segment.otherWorkspaceId && segment.kind !== 'file') {
		return (
			<OwnOtherWorkspaceChip
				kind={segment.kind}
				otherWorkspaceId={segment.otherWorkspaceId}
				id={segment.id}
			/>
		)
	}
	if (segment.kind === 'loop') return <OwnLoopChip workspaceId={workspaceId} id={segment.id} />
	if (segment.kind === 'trigger')
		return <OwnTriggerChip workspaceId={workspaceId} id={segment.id} />
	if (segment.kind === 'agent') return <OwnAgentChip workspaceId={workspaceId} id={segment.id} />
	if (segment.kind === 'chat') return <OwnChatChip workspaceId={workspaceId} id={segment.id} />
	return <OwnObjectOrFileChip workspaceId={workspaceId} segment={segment} />
}

/** A GitHub pull request or issue in your own message: icon, "{repo} #{n}" and an arrow, opening GitHub in a new tab. Nothing is fetched. */
function OwnGithubChip({ href, target }: { href: string; target: GithubTarget }) {
	const Icon = target.type === 'pull' ? GitPullRequest : CircleDot
	return (
		<a
			href={href}
			target="_blank"
			rel="noopener noreferrer"
			aria-label={githubChipName(target)}
			className={OWN_CHIP_CLASS}
		>
			<Icon size={12} aria-hidden className="shrink-0" />
			<span className="truncate">{githubChipText(target)}</span>
			<ArrowUpRight size={12} aria-hidden className="shrink-0" />
		</a>
	)
}

function OwnOtherWorkspaceChip({
	kind,
	otherWorkspaceId,
	id,
}: {
	kind: 'object' | 'loop' | 'trigger' | 'agent' | 'chat'
	otherWorkspaceId: string
	id: string
}) {
	const label = useOtherWorkspaceLabel(kind, otherWorkspaceId)
	return (
		<OtherWorkspaceLink
			kind={kind}
			otherWorkspaceId={otherWorkspaceId}
			id={id}
			label={label}
			newTab
			className={cn(OWN_CHIP_CLASS, 'border border-dashed border-primary-foreground/40 italic')}
		>
			<Globe size={12} aria-hidden className="shrink-0" />
			<span className="truncate">{label}</span>
		</OtherWorkspaceLink>
	)
}

function OwnLoopChip({ workspaceId, id }: { workspaceId: string; id: string }) {
	const { data: loop } = useLoop(id, workspaceId)
	const name = loop?.name?.trim()
	return (
		<Link
			to="/$workspaceId/loops/$loopId"
			params={{ workspaceId, loopId: id }}
			target="_blank"
			rel="noopener noreferrer"
			title={name}
			className={OWN_CHIP_CLASS}
		>
			<Link2 size={12} aria-hidden className="shrink-0" />
			<span className="truncate">{name ? chipTitle(name) : 'Loop'}</span>
		</Link>
	)
}

function OwnTriggerChip({ workspaceId, id }: { workspaceId: string; id: string }) {
	const { data: trigger } = useTrigger(id, workspaceId)
	const name = trigger?.name?.trim()
	return (
		<Link
			to="/$workspaceId/triggers/$triggerId"
			params={{ workspaceId, triggerId: id }}
			target="_blank"
			rel="noopener noreferrer"
			title={name}
			className={OWN_CHIP_CLASS}
		>
			<Link2 size={12} aria-hidden className="shrink-0" />
			<span className="truncate">{name ? chipTitle(name) : 'Trigger'}</span>
		</Link>
	)
}

function OwnAgentChip({ workspaceId, id }: { workspaceId: string; id: string }) {
	const { data: actors } = useActors(workspaceId, { enabled: true })
	const actor = actors?.find((a) => a.id === id)
	const name = actor?.name?.trim()
	// An address that points at a person is not an agent link: it stays a plain link.
	if (actor?.type === 'human') {
		const address = `${window.location.origin}/${workspaceId}/agents/${id}`
		return (
			<a href={address} target="_blank" rel="noopener noreferrer" className="underline">
				{address}
			</a>
		)
	}
	return (
		<Link
			to="/$workspaceId/agents/$agentId"
			params={{ workspaceId, agentId: id }}
			target="_blank"
			rel="noopener noreferrer"
			title={name}
			className={OWN_CHIP_CLASS}
		>
			<Link2 size={12} aria-hidden className="shrink-0" />
			<span className="truncate">{name ? chipTitle(name) : 'Agent'}</span>
		</Link>
	)
}

function OwnChatChip({ workspaceId, id }: { workspaceId: string; id: string }) {
	const chat = useLinkedChat(workspaceId, id)
	const name = chat?.title.trim()
	return (
		<Link
			to="/$workspaceId/chats/$conversationId"
			params={{ workspaceId, conversationId: id }}
			target="_blank"
			rel="noopener noreferrer"
			title={name}
			className={OWN_CHIP_CLASS}
		>
			<Link2 size={12} aria-hidden className="shrink-0" />
			<span className="truncate">{name ? chipTitle(name) : 'Chat'}</span>
		</Link>
	)
}

function OwnObjectOrFileChip({
	workspaceId,
	segment,
}: {
	workspaceId: string
	segment: { kind: 'object' | 'file'; id: string }
}) {
	const isObject = segment.kind === 'object'
	const { data: object } = useObject(segment.id, { enabled: isObject })
	const { data: files } = useFiles(workspaceId, { ids: isObject ? [] : [segment.id] })
	const name = (isObject ? object?.title : files?.[0]?.name)?.trim()
	const label = name ? chipTitle(name) : isObject ? 'Object' : 'File'
	const className = OWN_CHIP_CLASS
	const content = (
		<>
			<Link2 size={12} aria-hidden className="shrink-0" />
			<span className="truncate">{label}</span>
		</>
	)
	return isObject ? (
		<Link
			to="/$workspaceId/objects/$objectId"
			params={{ workspaceId, objectId: segment.id }}
			target="_blank"
			rel="noopener noreferrer"
			title={name}
			className={className}
		>
			{content}
		</Link>
	) : (
		<Link
			to="/$workspaceId/files/$fileId"
			params={{ workspaceId, fileId: segment.id }}
			target="_blank"
			rel="noopener noreferrer"
			title={name}
			className={className}
		>
			{content}
		</Link>
	)
}

/**
 * Renders an inline pill per mention on the message bubble. Each pill is an
 * inline-flex row with the actor's 14px avatar and name, `border-radius: 999px`,
 * no border (`bg-brand-subtle text-brand-subtle-foreground` maps to the spec's
 * brand-tinted chip). Self-mention swaps to `bg-warning/10 text-warning` so the
 * sender sees they've pinged themselves. Clicking a pill navigates to the
 * actor's detail route — the closest primitive we have to the "profile drawer"
 * spec, which doesn't ship in the app yet.
 */
function MentionPills({
	mentions,
	workspaceId,
	actorLookup,
	selfActorId,
}: {
	mentions: string[]
	workspaceId: string
	actorLookup: Map<string, { id: string; name: string; type: string }>
	selfActorId: string | null
}) {
	return (
		<ul className="flex flex-wrap items-center gap-1.5 p-0" aria-label="Mentions">
			{mentions.map((id) => {
				const actor = actorLookup.get(id)
				const name = actor?.name?.trim() || id
				const isSelf = selfActorId === id
				const chipClasses = cn(
					'inline-flex max-w-full items-center gap-1.5 rounded-full px-[6px] pl-1 py-[1px] text-[11.5px] font-semibold',
					isSelf ? 'bg-warning/10 text-warning' : 'bg-brand/10 text-brand',
				)
				const label = (
					<>
						<ActorAvatar
							id={id}
							name={name}
							type={actor?.type ?? 'agent'}
							size="sm"
							className="h-[14px] w-[14px] shrink-0 text-[8px]"
						/>
						<span className="max-w-[12rem] truncate">@{name}</span>
					</>
				)
				return (
					<li key={id}>
						{actor && !isSelf ? (
							<Link
								to="/$workspaceId/agents/$agentId"
								params={{ workspaceId, agentId: id }}
								className={chipClasses}
							>
								{label}
							</Link>
						) : (
							<span className={chipClasses}>{label}</span>
						)}
					</li>
				)
			})}
		</ul>
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
