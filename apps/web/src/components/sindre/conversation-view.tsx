import { ConversationComposer } from '@/components/sindre/conversation-composer'
import { ConversationTranscript } from '@/components/sindre/conversation-transcript'
import { ParticipantBar } from '@/components/sindre/participant-bar'
import type { UseSindreConversationResult } from '@/hooks/use-sindre-conversation'
import { getStoredActor } from '@/lib/auth'
import { cn } from '@/lib/cn'
import type { SindreAttachment } from '@/lib/sindre-context'
import {
	EMPTY_SINDRE_SELECTION,
	type SindreSelection,
	sindreSelectionReducer,
} from '@/lib/sindre-selection'
import type { UserAttachmentView } from '@/lib/sindre-stream'
import { MessagesSquare, Sparkles } from 'lucide-react'
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'

interface ConversationViewProps {
	workspaceId: string
	conversation: UseSindreConversationResult
	pendingMessage: string | null
	clearPendingMessage: () => void
	pendingAttachments: SindreAttachment[]
	clearPendingAttachments: () => void
}

/**
 * Body of the multiplayer Sindre panel: participant roster, the attributed
 * transcript (or an empty state with starter prompts), and the composer. Owns
 * the per-send context selection (objects / notifications / files) and the
 * composer draft, and forwards messages plus context to the conversation
 * orchestrator passed in via `conversation`.
 */
export function ConversationView({
	workspaceId,
	conversation,
	pendingMessage,
	clearPendingMessage,
	pendingAttachments,
	clearPendingAttachments,
}: ConversationViewProps) {
	const [selection, dispatch] = useReducer(sindreSelectionReducer, EMPTY_SINDRE_SELECTION)
	const [draft, setDraft] = useState('')
	const currentUserId = useMemo(() => getStoredActor()?.id ?? 'you', [])

	const {
		messages,
		participants,
		allAgents,
		workingAgentIds,
		isBusy,
		send,
		stop,
		regenerate,
		addParticipant,
		removeParticipant,
	} = conversation

	const handleSend = useCallback(() => {
		const text = draft.trim()
		if (text.length === 0) return
		send({
			text,
			objects: selection.objects,
			notifications: selection.notifications,
			files: selection.files,
			displayAttachments: buildDisplayAttachments(selection),
		})
		dispatch({ type: 'clear_all' })
		setDraft('')
	}, [draft, selection, send])

	// Auto-send a message forwarded from another surface (the Pulse input bar
	// opens the panel and hands off the user's first message + any context).
	const pendingConsumedRef = useRef(false)
	useEffect(() => {
		if (!pendingMessage || pendingMessage.length === 0) {
			pendingConsumedRef.current = false
			return
		}
		if (pendingConsumedRef.current) return
		pendingConsumedRef.current = true
		const { objects, notifications, displayAttachments, mentionPrefix } =
			splitPendingAttachments(pendingAttachments)
		send({
			text: `${mentionPrefix}${pendingMessage}`,
			objects,
			notifications,
			displayAttachments:
				displayAttachments.length > 0 ? displayAttachments : undefined,
		})
		clearPendingMessage()
		clearPendingAttachments()
	}, [pendingMessage, pendingAttachments, send, clearPendingMessage, clearPendingAttachments])

	// When the panel is opened with context but no message to auto-send (e.g.
	// the Pulse card's "Talk to Sindre" on a notification), stage the
	// attachments into the composer so the user sees the chips / participants
	// and can type their message instead of losing the context.
	useEffect(() => {
		if (pendingMessage && pendingMessage.length > 0) return
		if (pendingAttachments.length === 0) return
		for (const a of pendingAttachments) {
			if (a.kind === 'object') {
				dispatch({
					type: 'add_object',
					object: { id: a.id, title: a.title ?? null, type: a.type ?? null },
				})
			} else if (a.kind === 'notification') {
				dispatch({ type: 'add_notification', notification: { id: a.id, title: a.title ?? null } })
			} else if (a.kind === 'agent') {
				addParticipant(a.id)
			}
		}
		clearPendingAttachments()
	}, [pendingMessage, pendingAttachments, addParticipant, clearPendingAttachments])

	const isEmpty = messages.length === 0

	return (
		<div className="flex h-full min-h-0 flex-col gap-2">
			<ParticipantBar
				participants={participants}
				allAgents={allAgents}
				workingAgentIds={workingAgentIds}
				onAdd={addParticipant}
				onRemove={removeParticipant}
				className="shrink-0 px-1"
			/>
			{isEmpty ? (
				<EmptyState onPick={setDraft} />
			) : (
				<ConversationTranscript
					messages={messages}
					currentUserId={currentUserId}
					onRegenerate={regenerate}
					onEditUserMessage={setDraft}
					className="min-h-0 flex-1"
				/>
			)}
			<ConversationComposer
				workspaceId={workspaceId}
				agents={allAgents}
				value={draft}
				onValueChange={setDraft}
				onSend={handleSend}
				onStop={() => stop()}
				isBusy={isBusy}
				selection={selection}
				onDispatchSelection={dispatch}
			/>
		</div>
	)
}

const STARTER_PROMPTS = [
	'Summarize what needs my attention right now',
	'What are the most important open bets?',
	'Draft a status update for the team',
	'Help me prioritize my work for today',
]

function EmptyState({ onPick }: { onPick: (text: string) => void }) {
	return (
		<div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 px-4 text-center">
			<div className="flex h-11 w-11 items-center justify-center rounded-full bg-primary/10 text-primary">
				<MessagesSquare size={22} aria-hidden />
			</div>
			<div className="space-y-1">
				<p className="font-medium text-foreground text-sm">Start a conversation</p>
				<p className="text-text-muted text-xs">
					Chat with Sindre, or use{' '}
					<span className="rounded bg-bg-surface px-1 font-mono text-text-secondary">@</span> to
					bring other agents into the room.
				</p>
			</div>
			<ul className="flex w-full max-w-sm flex-col gap-1.5">
				{STARTER_PROMPTS.map((prompt) => (
					<li key={prompt}>
						<button
							type="button"
							onClick={() => onPick(prompt)}
							className="flex w-full items-center gap-2 rounded-md border border-border bg-bg-surface px-3 py-2 text-left text-foreground text-sm transition-colors hover:bg-bg-hover"
						>
							<Sparkles size={14} className="shrink-0 text-text-muted" aria-hidden />
							<span className="min-w-0 flex-1 truncate">{prompt}</span>
						</button>
					</li>
				))}
			</ul>
		</div>
	)
}

function buildDisplayAttachments(selection: SindreSelection): UserAttachmentView[] | undefined {
	const out: UserAttachmentView[] = []
	for (const o of selection.objects) {
		out.push({ kind: 'object', id: o.id, title: o.title ?? null, type: o.type ?? null })
	}
	for (const n of selection.notifications) {
		out.push({ kind: 'notification', id: n.id, title: n.title ?? null })
	}
	for (const f of selection.files) {
		out.push({ kind: 'file', name: f.name, sizeBytes: f.sizeBytes })
	}
	return out.length > 0 ? out : undefined
}

/**
 * Splits the panel's forwarded attachments into send args. Object/notification
 * attachments become context; agent attachments become an inline `@mention`
 * prefix so the orchestrator routes the reply to them.
 */
function splitPendingAttachments(attachments: SindreAttachment[]): {
	objects: { id: string; title: string | null; type: string | null }[]
	notifications: { id: string; title: string | null }[]
	displayAttachments: UserAttachmentView[]
	mentionPrefix: string
} {
	const objects: { id: string; title: string | null; type: string | null }[] = []
	const notifications: { id: string; title: string | null }[] = []
	const displayAttachments: UserAttachmentView[] = []
	const mentions: string[] = []
	for (const a of attachments) {
		if (a.kind === 'object') {
			objects.push({ id: a.id, title: a.title ?? null, type: a.type ?? null })
			displayAttachments.push({ kind: 'object', id: a.id, title: a.title ?? null, type: a.type ?? null })
		} else if (a.kind === 'notification') {
			notifications.push({ id: a.id, title: a.title ?? null })
			displayAttachments.push({ kind: 'notification', id: a.id, title: a.title ?? null })
		} else if (a.kind === 'agent' && a.name) {
			mentions.push(`@${a.name}`)
		}
	}
	const mentionPrefix = mentions.length > 0 ? `${mentions.join(' ')} ` : ''
	return { objects, notifications, displayAttachments, mentionPrefix }
}
