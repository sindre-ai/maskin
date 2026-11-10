import {
	renderLinkedCard,
	renderLinkedChip,
	renderLinkedGithubChip,
	renderLinkedSettingsChip,
} from '@/components/chat/linked-object-preview'
import {
	ObjectReferenceCard,
	ObjectReferenceChip,
	OtherWorkspaceLink,
	useOtherWorkspaceLabel,
} from '@/components/chat/linked-object-reference'
import { ActorAvatar } from '@/components/shared/actor-avatar'
import { MarkdownContent } from '@/components/shared/markdown-content'
import { ObjectReference } from '@/components/shared/object-reference'
import { RelativeTime } from '@/components/shared/relative-time'
import { ViewerTooltip } from '@/components/shared/viewer-tooltip'
import { useActors } from '@/hooks/use-actors'
import { useCanWrite } from '@/hooks/use-can-write'
import { useConversation, useEditMessage, useRetryMessage } from '@/hooks/use-conversation'
import { useFiles } from '@/hooks/use-files'
import { useFitTextWidth } from '@/hooks/use-fit-text-width'
import { useLinkedChat } from '@/hooks/use-linked-chat'
import { useLoop } from '@/hooks/use-loops'
import { useToggleReaction } from '@/hooks/use-message-reactions'
import { useObject } from '@/hooks/use-objects'
import { useTrigger } from '@/hooks/use-triggers'
import type { MessageContextNotification, MessageContextObject, MessageResponse } from '@/lib/api'
import { getStoredActor } from '@/lib/auth'
import { cn } from '@/lib/cn'
import { isFailedReply } from '@/lib/failed-turns'
import {
	type GithubTarget,
	type OwnCard,
	type OwnPlacement,
	type SettingsTarget,
	githubChipName,
	githubChipText,
	isOnlyCard,
	placeOwnLinks,
	settingsChipText,
	splitOwnLinks,
} from '@/lib/linked-objects'
import { type TagSegment, splitTextByTags, tagLabel } from '@/lib/tag-input-model'
import { useIsEnterpriseWorkspace } from '@/lib/workspace-context'
import { formatQuestionsAsMarkdown } from '@maskin/shared'
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
	Settings as SettingsIcon,
} from 'lucide-react'
import { Fragment, type Ref, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { ComputerRequestCard } from './computer-request-card'
import { EditMessageCard } from './edit-message-card'
import { HandedOffStrip } from './handed-off-strip'
import { HandoffCard } from './handoff-card'
import { IntegrationAccessRequestCard } from './integration-access-request-card'
import { IntegrationConnectCard } from './integration-connect-card'
import { KeychainAccessRequestCard } from './keychain-access-request-card'
import { KeychainRequestCard } from './keychain-request-card'
import { McpServerRequestCard } from './mcp-server-request-card'
import { type MessageAttachmentItem, MessageAttachments } from './message-attachments'
import { MessageDivider } from './message-divider'
import { ReactButton, ReactionChips } from './message-reactions'
import { QuestionOptions } from './question-options'
import { type MessageSpawnInfo, SpawnChip } from './spawn-indicator'
import { TagChip } from './tag-chip'
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

// With attachments, the fitted own bubble stays this wide so 'ok' does not make a tiny thumbnail.
const MIN_FIT_WIDTH = 160

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
	const enterprise = useIsEnterpriseWorkspace()
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
	// Editing and asking agents again are writes; a viewer keeps the buttons, switched off.
	const canWrite = useCanWrite()
	const editMessage = useEditMessage(message.conversationId, workspaceId)
	const { data: conversation } = useConversation(message.conversationId, workspaceId)
	const conversationParticipantIds = useMemo(
		() => (conversation?.participants ?? []).map((p) => p.actorId),
		[conversation],
	)
	// Focus goes back to the pencil once the edit card closes, whether it saved or not.
	const pencilRef = useRef<HTMLButtonElement | null>(null)
	const wasEditing = useRef(false)
	useEffect(() => {
		if (wasEditing.current && !editing) pencilRef.current?.focus()
		wasEditing.current = editing
	}, [editing])
	const retryMessage = useRetryMessage(message.conversationId, workspaceId)
	// Reacting is a write; a viewer keeps the button and the chips, switched off. Only a real,
	// persisted message can be reacted to (not an optimistic bubble, not a system row).
	const { toggle: toggleReaction } = useToggleReaction(message.conversationId, workspaceId)
	// Not an optimistic bubble, a system row, a deleted message or an agent's failed-turn notice.
	const canReact =
		message.id > 0 && message.kind === 'message' && !message.deletedAt && !isFailedReply(message)
	// A deleted message keeps no chips.
	const reactions = message.deletedAt ? undefined : message.reactions
	const onToggleReaction = (emoji: string) => toggleReaction(message.id, emoji)
	// The picker is portaled out of the action row, so the row cannot count on focus-within or
	// hover to stay visible while it is open.
	const [reactionPickerOpen, setReactionPickerOpen] = useState(false)
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
	// An agent's question is posted with its markdown twin as the message content (for readers that
	// have no card). Here the card shows every question and option description itself, so the
	// twin is not drawn above it. Words the agent wrote of its own never match and stay.
	const question = message.metadata?.question
	const isQuestionTwin =
		question !== undefined && message.content === formatQuestionsAsMarkdown(question.questions)
	const shownContent =
		isOwn && answers && answers.length > 0 && message.content.startsWith('**')
			? answers
					.map((a) => (answers.length > 1 ? `${a.header}: ` : '') + a.selected.join(', '))
					.join('\n')
			: message.content
	const placedParts = useMemo(
		() =>
			isOwn
				? placeOwnLinks(splitOwnLinks(shownContent, workspaceId, enterprise), shownLinkedObjectIds)
				: [],
		[isOwn, shownContent, workspaceId, enterprise, shownLinkedObjectIds],
	)
	// One card and nothing else (no words, no attachments, not being edited): the card is the message.
	const cardOnly = isOwn && !editing && attachments.length === 0 && isOnlyCard(placedParts)
	// A bubble that holds a card is a fixed width so the card has room, instead of the width of its words.
	const holdsCard = isOwn && !editing && !cardOnly && placedParts.some((p) => p.kind === 'card')

	// Tags in your own words are drawn as chips where they stand: each tagged id claims its
	// "@Name" in the text. A message sent before tags lived in the text has none of its ids in the
	// text, and keeps the "You mentioned" row. Once any tag sits in the text the row is gone, so an
	// id left over (a thread reply's default recipient) is not shown as a mention above words that
	// tag someone else.
	const tagActors = useMemo(
		() => (workspaceActors ?? []).filter((a) => !a.isSystem),
		[workspaceActors],
	)
	const tagLabelOf = useMemo(() => {
		const byId = new Map(tagActors.map((a) => [a.id, a]))
		return (id: string) => {
			const found = byId.get(id)
			return found ? tagLabel(found, tagActors) : null
		}
	}, [tagActors])
	const { ownParts, untaggedMentions } = useMemo(() => {
		let remaining = mentions
		const parts = placedParts.map((part): OwnBodyPart => {
			if (part.kind !== 'text' || remaining.length === 0) return part
			const split = splitTextByTags(part.text, remaining, tagLabelOf)
			remaining = split.unmatchedIds
			return { kind: 'tagged', parts: split.segments }
		})
		return {
			ownParts: parts,
			untaggedMentions: remaining.length === mentions.length ? remaining : [],
		}
	}, [placedParts, mentions, tagLabelOf])

	// Your own words with a bubble: its column shrinks to the widest line of text, and lifted
	// attachments take the same width. Editing, a message with no text and a message with a card
	// (which has its own width) keep the full layout.
	const fitText = isOwn && !editing && message.content.length > 0 && !cardOnly && !holdsCard
	const { columnRef, plateRef, textRef } = useFitTextWidth({
		enabled: fitText,
		minWidth: attachments.length > 0 ? MIN_FIT_WIDTH : 0,
		contentKey: shownContent,
	})

	if (message.kind === 'system') {
		return <MessageDivider label={message.content} />
	}

	const liftedAttachments =
		attachments.length > 0 ? (
			<MessageAttachments
				workspaceId={workspaceId}
				align={isOwn ? 'end' : 'start'}
				fill={fitText}
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

	if (isOwn) {
		// A message that is only attachments has no bubble.
		const hasPlate = editing || message.content.length > 0
		const startEditing = () => {
			editMessage.reset()
			setEditing(true)
		}
		const saveEdit = ({ text, ids }: { text: string; ids: string[] }) => {
			editMessage.mutate(
				{ messageId: message.id, content: text.trim(), mentions: ids },
				{ onSuccess: () => setEditing(false) },
			)
		}
		return (
			<div
				className={cn(
					'flex flex-col items-end',
					// Attachments stack 4px above the text bubble.
					'gap-1',
					editing && 'w-full',
				)}
			>
				{hasContext ? (
					<div className="flex max-w-[min(560px,80%)] flex-wrap items-center justify-end gap-1.5">
						<span className="eyebrow shrink-0">YOU ATTACHED</span>
						<OwnContextChips objects={contextObjects} notifications={contextNotifications} />
					</div>
				) : null}
				{untaggedMentions.length > 0 && !editing ? (
					<div className="flex max-w-[min(560px,80%)] flex-wrap items-center justify-end gap-1.5">
						<span className="eyebrow shrink-0">You mentioned</span>
						<MentionPills
							mentions={untaggedMentions}
							workspaceId={workspaceId}
							actorLookup={actorLookup}
							selfActorId={actor?.id ?? null}
						/>
					</div>
				) : null}
				{/* While fitting, the attachments and the bubble share one column, which gets the width of
				    the text. Otherwise the column adds no box of its own. */}
				<div
					ref={columnRef}
					className={cn(
						fitText ? 'flex max-w-[min(560px,80%)] flex-col items-end gap-1' : 'contents',
					)}
				>
					{fitText && liftedAttachments ? (
						<div className={'w-full'}>{liftedAttachments}</div>
					) : (
						liftedAttachments
					)}
					{hasPlate ? (
						<>
							<div
								className={cn(
									// While fitting, the column above carries the width cap. The edit card takes the row,
									// up to the bubble's own cap, so its buttons always fit. A lone card fills the column up
									// to 460px; a bubble with a card is min(520px, 88% of the column).
									fitText
										? 'relative w-full'
										: editing
											? 'relative max-w-[560px]'
											: cardOnly
												? 'relative w-full max-w-[460px]'
												: holdsCard
													? 'relative w-[min(520px,88%)]'
													: 'relative max-w-[min(560px,80%)]',
									editing && 'w-full',
								)}
							>
								<div
									ref={plateRef}
									className={
										// A message that is only a card has no plate: the card is the message. The edit
										// card is a plain card on the page, so it drops the plate too.
										cardOnly
											? 'contents'
											: editing
												? 'flex flex-col gap-1.5'
												: 'flex flex-col gap-1.5 rounded-2xl bg-secondary px-3.5 py-[9px] text-[15px] leading-[1.4] text-foreground'
									}
								>
									{editing ? (
										<EditMessageCard
											workspaceId={workspaceId}
											conversationParticipantIds={conversationParticipantIds}
											selfActorId={actor?.id ?? null}
											content={message.content}
											mentions={mentions}
											labelOf={tagLabelOf}
											agentName={(id) => {
												const found = actorLookup.get(id)
												return found?.type === 'agent' ? found.name : null
											}}
											saving={editMessage.isPending}
											failed={editMessage.isError}
											onSave={saveEdit}
											onCancel={() => setEditing(false)}
										/>
									) : message.content.length > 0 ? (
										// `break-words` is load-bearing next to the column's `min-w-0`:
										// `min-w-0` bounds the box, this bounds the ink. Without it an
										// unbroken token (a long URL) raises this span's min-content and
										// paints past the bubble's `max-w` cap, out to the viewport edge.
										<OwnMessageBody
											parts={ownParts}
											workspaceId={workspaceId}
											inBubble={!cardOnly}
											textRef={fitText ? textRef : undefined}
											selfActorId={actor?.id ?? null}
											isAgent={(id) => actorLookup.get(id)?.type === 'agent'}
										/>
									) : null}
								</div>
							</div>
						</>
					) : null}
				</div>
				{spawnInfo ? <SpawnChip info={spawnInfo} /> : null}
				<ReactionChips
					reactions={reactions}
					meId={actor?.id}
					onToggle={onToggleReaction}
					disabled={!canWrite}
					className="justify-end"
				/>
				{/* The actions sit permanently in the timestamp row rather than
				    revealing on hover — a touch viewport has no hover, and the
				    ship gate asserts plain visibility at 375px. */}
				<div className="flex items-center gap-1">
					{editing ? <span className="text-[10px] text-muted-foreground">Editing ·</span> : null}
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
					{canReact && !editing ? (
						<ViewerTooltip>
							<ReactButton
								reactions={reactions}
								onToggle={onToggleReaction}
								disabled={!canWrite}
								onOpenChange={setReactionPickerOpen}
							/>
						</ViewerTooltip>
					) : null}
					{canAct && !editing ? (
						<>
							<ViewerTooltip>
								<button
									ref={pencilRef}
									type="button"
									onClick={startEditing}
									disabled={!canWrite}
									aria-label="Edit message"
									className="rounded p-1 text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
								>
									<Pencil size={12} aria-hidden />
								</button>
							</ViewerTooltip>
							<ViewerTooltip>
								<button
									type="button"
									onClick={() =>
										retryMessage.mutate(
											{ messageId: message.id },
											{ onSuccess: () => onRetried?.(message) },
										)
									}
									disabled={retryMessage.isPending || !canWrite}
									aria-label="Ask agents to respond again"
									className="rounded p-1 text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
								>
									<RotateCcw size={12} aria-hidden />
								</button>
							</ViewerTooltip>
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
				name={message.actorName}
				type={message.actorType ?? 'agent'}
				id={message.actorId}
				size="md"
				className="mt-0.5 size-[30px] shrink-0 rounded-[9px] bg-secondary text-[11px] font-bold text-foreground"
			/>
			<div className={'relative min-w-0 flex-1'}>
				<div className="flex items-baseline gap-1.5">
					{message.actorType === 'agent' && message.actorId ? (
						<Link
							to="/$workspaceId/agents/$agentId"
							params={{ workspaceId, agentId: message.actorId }}
							className="truncate text-[13px] font-semibold text-foreground hover:underline"
						>
							{message.actorName}
						</Link>
					) : (
						<span className="truncate text-[13px] font-semibold text-foreground">
							{message.actorName}
						</span>
					)}
					<RelativeTime
						date={message.createdAt}
						format="clock"
						className="shrink-0 text-xs text-muted-foreground"
					/>
					{isVoice ? <VoiceMessageMetaTag /> : null}
				</div>
				{activity ? <div className="mt-0.5">{activity}</div> : null}
				{liftedAttachments ? <div className="mt-1.5">{liftedAttachments}</div> : null}
				{message.content.length > 0 && !isQuestionTwin ? (
					<div className="mt-0.5 text-base leading-[1.45] [&_li]:text-foreground [&_p]:text-base [&_p]:leading-[1.45] [&_p]:text-foreground">
						{/* `renderVisuals` turns a ```chart fenced block into the bounded
						    data-viz card (mockup 660–679). Agents are told how to emit one
						    in `createCommentSchema`'s content description, and the same
						    parser backs item comments — no new payload, just the render
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
								enterprise,
								conversationId: message.conversationId,
								agentId: message.actorId,
								skipIds: shownLinkedObjectIds,
								updatedIds: updatedLinkedObjectIds,
								renderCard: renderLinkedCard,
								renderChip: renderLinkedChip,
								renderGithubChip: renderLinkedGithubChip,
								renderSettingsChip: renderLinkedSettingsChip,
							}}
						/>
					</div>
				) : null}
				{/* An agent's AskUserQuestion, surfaced as pickable options. The card carries
				    the questions and each option's description; the message's markdown twin
				    (`isQuestionTwin`) is only for readers that have no card. */}
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
						messageId={message.id}
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
				<ReactionChips
					reactions={reactions}
					meId={actor?.id}
					onToggle={onToggleReaction}
					disabled={!canWrite}
					className="mt-1.5"
				/>
				{canCopy || canReply || canReact ? (
					<div
						className={cn(
							'mt-1.5 flex items-center gap-1 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100 pointer-coarse:opacity-100 any-pointer-coarse:opacity-100',
							reactionPickerOpen && 'opacity-100',
						)}
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
						{canReact ? (
							<ViewerTooltip>
								<ReactButton
									reactions={reactions}
									onToggle={onToggleReaction}
									disabled={!canWrite}
									onOpenChange={setReactionPickerOpen}
								/>
							</ViewerTooltip>
						) : null}
						{canRetryAgent ? (
							<ViewerTooltip>
								<button
									type="button"
									onClick={() =>
										retryMessage.mutate(
											{ messageId: message.id },
											{ onSuccess: () => onRetried?.(message) },
										)
									}
									disabled={retryMessage.isPending || !canWrite}
									aria-label="Retry"
									className="rounded p-1 text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
								>
									<RotateCcw size={12} aria-hidden />
								</button>
							</ViewerTooltip>
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

/** What the own-message body draws: the placed links and cards, with the words split around their tags. */
type OwnBodyPart = OwnPlacement | { kind: 'tagged'; parts: TagSegment[] }

const OWN_CHIP_CLASS =
	'inline-flex max-w-full items-center gap-1 rounded-md bg-foreground/10 px-1.5 py-0.5 align-baseline font-medium text-foreground transition-colors hover:bg-foreground/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'

/**
 * What you wrote, in order: words, a chip for each link, and a card for an object linked on a
 * line of its own. In a bubble the cards sit nested under the words they follow; a message that is
 * only a card has no bubble. Objects open in a new tab.
 */
function OwnMessageBody({
	parts,
	workspaceId,
	inBubble,
	textRef,
	selfActorId,
	isAgent,
}: {
	parts: OwnBodyPart[]
	workspaceId: string
	inBubble: boolean
	/** The words, measured to fit the bubble to them (only set when the message holds no card). */
	textRef?: Ref<HTMLSpanElement>
	selfActorId: string | null
	isAgent: (id: string) => boolean
}) {
	const runs: Array<{ card: OwnCard } | { inline: Exclude<OwnBodyPart, OwnCard>[] }> = []
	for (const part of parts) {
		const last = runs[runs.length - 1]
		if (part.kind === 'card') runs.push({ card: part })
		else if (last && 'inline' in last) last.inline.push(part)
		else runs.push({ inline: [part] })
	}
	return (
		<>
			{runs.map((run, index) =>
				'card' in run ? (
					<ObjectReferenceCard
						// biome-ignore lint/suspicious/noArrayIndexKey: runs are positional by construction
						key={index}
						workspaceId={workspaceId}
						objectId={run.card.id}
						newTab
						// In a bubble the card fills it, 8px under the words (the bubble's gap is 6px) and
						// with a light shadow; a lone card is the message and fills its wrapper.
						className={cn(
							'my-0 w-full max-w-full',
							inBubble && 'shadow-xs',
							inBubble && index > 0 && 'mt-0.5',
						)}
					/>
				) : (
					// `break-words` is load-bearing next to the column's `min-w-0`: `min-w-0` bounds the
					// box, this bounds the ink. Without it an unbroken token (a long URL) raises this
					// span's min-content and paints past the bubble's `max-w` cap, out to the viewport edge.
					<span
						// biome-ignore lint/suspicious/noArrayIndexKey: runs are positional by construction
						key={index}
						ref={textRef}
						className="whitespace-pre-wrap break-words"
					>
						{run.inline.map((part, i) =>
							part.kind === 'tagged' ? (
								// biome-ignore lint/suspicious/noArrayIndexKey: parts are positional by construction
								<Fragment key={i}>
									{part.parts.map((tagPart, tagIndex) =>
										tagPart.kind === 'text' ? (
											// biome-ignore lint/suspicious/noArrayIndexKey: positional by construction
											<Fragment key={tagIndex}>{tagPart.text}</Fragment>
										) : (
											<TagChip
												// biome-ignore lint/suspicious/noArrayIndexKey: the same person can be tagged twice
												key={tagIndex}
												workspaceId={workspaceId}
												id={tagPart.id}
												label={tagPart.label}
												surface="card"
												isSelf={tagPart.id === selfActorId}
												linkable={isAgent(tagPart.id)}
											/>
										),
									)}
								</Fragment>
							) : part.kind === 'text' ? (
								// biome-ignore lint/suspicious/noArrayIndexKey: parts are positional by construction
								<Fragment key={i}>{part.text}</Fragment>
							) : part.kind === 'other' ? (
								<OwnLinkChip
									// biome-ignore lint/suspicious/noArrayIndexKey: the same link can appear twice
									key={i}
									workspaceId={workspaceId}
									segment={part.segment}
								/>
							) : part.kind === 'file' ? (
								<OwnLinkChip
									// biome-ignore lint/suspicious/noArrayIndexKey: the same link can appear twice
									key={i}
									workspaceId={workspaceId}
									segment={{ kind: 'file', id: part.id }}
								/>
							) : (
								<ObjectReferenceChip
									// biome-ignore lint/suspicious/noArrayIndexKey: the same link can appear twice
									key={i}
									workspaceId={workspaceId}
									objectId={part.id}
									newTab
									cardFollows={false}
									fallback={part.address}
								/>
							),
						)}
					</span>
				),
			)}
		</>
	)
}

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
		| { kind: 'settings'; target: SettingsTarget }
}) {
	if (segment.kind === 'github') {
		return <OwnGithubChip href={segment.href} target={segment.target} />
	}
	if (segment.kind === 'settings') {
		return <OwnSettingsChip workspaceId={workspaceId} target={segment.target} />
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

/** A settings page in your own message: a gear and "Settings: {section}", opening the page in a new tab. Nothing is fetched. */
function OwnSettingsChip({
	workspaceId,
	target,
}: {
	workspaceId: string
	target: SettingsTarget
}) {
	const text = settingsChipText(target)
	return (
		<a
			href={`/${workspaceId}/settings${target.path ? `/${target.path}` : ''}`}
			target="_blank"
			rel="noopener noreferrer"
			aria-label={text}
			className={OWN_CHIP_CLASS}
		>
			<SettingsIcon size={12} aria-hidden className="shrink-0" />
			<span className="truncate">{text}</span>
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
			className={cn(OWN_CHIP_CLASS, 'border border-dashed border-foreground/40 italic')}
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
			<span className="truncate">{name ? chipTitle(name) : 'Flow'}</span>
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
	const label = name ? chipTitle(name) : isObject ? 'Item' : 'File'
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
