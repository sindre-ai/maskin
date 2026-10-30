import { Composer } from '@/components/chat/chat'
import { useActors } from '@/hooks/use-actors'
import {
	flattenMessagesOldestFirst,
	useConversation,
	useConversationMessages,
	useSendMessage,
} from '@/hooks/use-conversation'
import { useActiveSessionsForConversation } from '@/hooks/use-sessions'
import type { ConversationParticipantResponse, MessageMetadata } from '@/lib/api'
import { getStoredActor } from '@/lib/auth'
import {
	type ChatSelectionFile,
	EMPTY_CHAT_SELECTION,
	chatSelectionReducer,
} from '@/lib/chat-selection'
import { type ComposerCue, NEUTRAL_PLACEHOLDER, deriveComposerCue } from '@/lib/composer-cue'
import { MESSAGE_MAX_MENTIONS } from '@maskin/shared'
import { useCallback, useEffect, useMemo, useReducer, useState } from 'react'

const BOOTING_STATUSES = new Set(['pending', 'starting', 'queued'])

interface ThreadComposerProps {
	workspaceId: string
	conversationId: string
	/** A step was tapped: replace the draft with this text (when given) and focus the box. */
	fillRequest?: { text?: string; nonce: number } | null
	/**
	 * Makes this a reply under a top-level message: sends carry `thread_root_id` and
	 * `also_in_channel`, the recipient (when there is one) is seeded as a mention, and
	 * the draft is kept per thread. `onSent` runs after a send succeeds.
	 */
	reply?: {
		rootId: number
		recipient: { id: string; name: string } | null
		alsoInChannel: boolean
		onSent?: () => void
	}
}

/**
 * Adapts the existing `<Composer>` (attach/upload/slash-picker/send) to the
 * conversation send path. Objects/notifications picked via the slash picker
 * are sent as structured `metadata.context_objects` / `context_notifications`
 * (rendered as chips by `MessageBubble`) rather than inlined into the message
 * text — the backend rebuilds the equivalent context block for the agent's
 * prompt from that metadata (see `conversation-responder.ts`). Agents mentioned
 * via `@` or the `+` menu ride the message as `metadata.mentions`, and the
 * responder pipeline's mention fast-path auto-joins them as participants if
 * they weren't one already.
 */
export function ThreadComposer({
	workspaceId,
	conversationId,
	fillRequest,
	reply,
}: ThreadComposerProps) {
	const [selection, dispatch] = useReducer(chatSelectionReducer, EMPTY_CHAT_SELECTION)
	const [error, setError] = useState<string | null>(null)
	const sendMessage = useSendMessage(conversationId, workspaceId)
	const { data: conversation } = useConversation(conversationId, workspaceId)
	const messagesQuery = useConversationMessages(conversationId, workspaceId)
	const { data: workspaceActors } = useActors(workspaceId)

	const self = getStoredActor()
	// Where a pasted provider secret gets vaulted: the running session of this chat and
	// the agent running it. No running session, no vaulting (the guard still blocks). A
	// session still pending, starting or queued is an agent coming back from a relaunch:
	// vaulting another secret then would race the launch that is already reading keys.
	const { data: sessions } = useActiveSessionsForConversation(workspaceId, conversationId)
	const secretCapture = useMemo(() => {
		const live = sessions?.find((s) => s.status === 'running')
		if (!live) return null
		const agent = conversation?.participants.find((p) => p.actorId === live.actorId)
		return {
			sessionId: live.id,
			conversationId,
			agent: { id: live.actorId, name: agent?.actorName ?? 'the agent' },
		}
	}, [sessions, conversation?.participants, conversationId])
	const secretRestarting = useMemo(
		() => !secretCapture && !!sessions?.some((s) => BOOTING_STATUSES.has(s.status)),
		[secretCapture, sessions],
	)
	// Vault mode (the ! prefix) needs a running session to vault into. It waits while the
	// conversation has none, or has one still coming up (pending, starting or queued).
	const vaultModeBlocked =
		!sessions?.some((s) => s.status === 'running') ||
		sessions.some((s) => s.status === 'pending' || s.status === 'starting' || s.status === 'queued')
	const participantIds = useMemo(
		() => conversation?.participants.map((p) => p.actorId) ?? [],
		[conversation?.participants],
	)

	// The recipient arrives with async data, so it is seeded by an effect; the reducer
	// dedupes, so a re-run is a no-op.
	const replyRootId = reply?.rootId
	const recipient = reply?.recipient ?? null
	const recipientId = recipient?.id
	const recipientName = recipient?.name
	useEffect(() => {
		if (replyRootId === undefined || !recipientId) return
		dispatch({ type: 'add_agent', agent: { id: recipientId, name: recipientName } })
	}, [replyRootId, recipientId, recipientName])

	const handleSend = useCallback(
		async (content: string, extras?: { files: ChatSelectionFile[] }) => {
			setError(null)
			const metadata: MessageMetadata = {}
			const files = [...selection.files, ...(extras?.files ?? [])]
			if (files.length > 0) {
				metadata.attachments = files.map((f) => ({
					file_id: f.fileId,
					name: f.name,
					mime_type: f.mimeType ?? 'application/octet-stream',
					size_bytes: f.sizeBytes,
				}))
			}
			if (selection.objects.length > 0) {
				metadata.context_objects = selection.objects.map((o) => ({
					id: o.id,
					...(o.title ? { title: o.title } : {}),
					...(o.type ? { type: o.type } : {}),
				}))
			}
			if (selection.notifications.length > 0) {
				metadata.context_notifications = selection.notifications.map((n) => ({
					id: n.id,
					...(n.title ? { title: n.title } : {}),
				}))
			}
			// Self-mention short-circuits the notification write by never reaching
			// the wire — the composer surfaced the warning chip, the send drops
			// the id. Every other mention rides as-is (capped, insertion order).
			const mentions = selection.agents
				.filter((id) => id !== self?.id)
				.slice(0, MESSAGE_MAX_MENTIONS)
			if (mentions.length > 0) {
				metadata.mentions = mentions
			}

			try {
				await sendMessage.mutateAsync({
					content,
					...(Object.keys(metadata).length > 0 ? { metadata } : {}),
					...(reply ? { thread_root_id: reply.rootId, also_in_channel: reply.alsoInChannel } : {}),
				})
				dispatch({ type: 'clear_all' })
				// clear_all wipes the seeded recipient; the next reply is still addressed to them.
				if (reply?.recipient) {
					dispatch({
						type: 'add_agent',
						agent: { id: reply.recipient.id, name: reply.recipient.name },
					})
				}
				reply?.onSent?.()
			} catch (err) {
				setError(err instanceof Error ? err.message : 'Failed to send message')
				throw err
			}
		},
		[selection, sendMessage, self?.id, reply],
	)

	// Name who you are answering (mockup 7850). "Message this conversation"
	// gave the composer no subject in a thread whose other party is the whole
	// point of opening it; a mention picked in the composer overrides the
	// name because that mention, not the thread's lead, is who replies.
	const firstMentionName =
		selection.agents.length > 0 ? selection.agentNames[selection.agents[0]] : undefined
	const counterpart =
		firstMentionName ?? conversation?.participants.find((p) => p.actorId !== self?.id)?.actorName
	const todaysPlaceholder = reply
		? firstMentionName
			? `Reply to ${firstMentionName}…`
			: 'Reply…'
		: counterpart
			? `Reply to ${counterpart}…`
			: 'Message… / reference or create · @ mention'

	// Group-chat cue (3 or more active participants). While a needed answer is still
	// loading it is the neutral placeholder with no hint; the box itself is never disabled.
	// In a small chat the cue is null and today's text stays.
	const cue = useMemo<ComposerCue | null>(() => {
		if (!conversation) return { placeholder: NEUTRAL_PLACEHOLDER, hint: null }
		const joiningAgents: ConversationParticipantResponse[] = []
		for (const id of selection.agents) {
			if (conversation.participants.some((p) => p.actorId === id)) continue
			// An id missing from the workspace list counts as a person.
			const known = workspaceActors?.find((a) => a.id === id)
			if (known?.type === 'agent') {
				joiningAgents.push({
					actorId: id,
					actorName: known.name,
					actorType: 'agent',
					joinedAt: null,
					addedBy: null,
				})
			}
		}
		return deriveComposerCue({
			selfId: self?.id ?? '',
			participants: conversation.participants,
			joiningAgents,
			taggedIds: selection.agents,
			messages: messagesQuery.data ? flattenMessagesOldestFirst(messagesQuery.data) : null,
			hasMoreMessages: messagesQuery.hasNextPage,
		})
	}, [
		conversation,
		selection.agents,
		workspaceActors,
		messagesQuery.data,
		messagesQuery.hasNextPage,
		self?.id,
	])
	// A reply names who it answers, which is the point of the box; the group-chat cue's wording
	// is for starting a message, so it keeps only its hint here.
	const placeholder = reply ? todaysPlaceholder : (cue?.placeholder ?? todaysPlaceholder)

	return (
		<Composer
			workspaceId={workspaceId}
			onSend={handleSend}
			longTextAsFile
			disabled={false}
			pending={sendMessage.isPending}
			surface="sheet"
			placeholder={placeholder}
			selection={selection}
			onDispatchSelection={dispatch}
			conversationParticipantIds={participantIds}
			onRemoveAgent={(id) => dispatch({ type: 'remove_agent', id })}
			onRemoveObject={(id) => dispatch({ type: 'remove_object', id })}
			onRemoveNotification={(id) => dispatch({ type: 'remove_notification', id })}
			onRemoveFile={(fileId) => dispatch({ type: 'remove_file', fileId })}
			externalError={error}
			onDismissExternalError={() => setError(null)}
			hint={cue ? cue.hint : undefined}
			// The accessible name stays constant while the visible placeholder
			// names the counterpart — a name that changed with the thread's lead
			// would make the same control a different control to a screen reader.
			textareaLabel={reply ? 'Reply in thread' : 'Message this conversation'}
			draftKey={reply ? `${conversationId}:reply:${reply.rootId}` : conversationId}
			fillRequest={fillRequest}
			inlineTags
			secretCapture={secretCapture}
			secretRestarting={secretRestarting}
			vaultModeBlocked={vaultModeBlocked}
		/>
	)
}
