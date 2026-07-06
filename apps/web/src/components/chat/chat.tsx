import { ChatTranscript } from '@/components/chat/chat-transcript'
import { SelectionChips } from '@/components/chat/selection-chips'
import {
	type SlashKindId,
	SlashPicker,
	type SlashPickerResult,
} from '@/components/chat/slash-picker'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { Textarea } from '@/components/ui/textarea'
import { useChatOneShot } from '@/hooks/use-chat-one-shot'
import { useChatSession } from '@/hooks/use-chat-session'
import { useConversationMessages } from '@/hooks/use-conversations'
import type { MessageResponse, SessionInputAttachment } from '@/lib/api'
import { getStoredActor } from '@/lib/auth'
import {
	type ChatSelection,
	type ChatSelectionAction,
	type ChatSelectionNotification,
	type ChatSelectionObject,
	EMPTY_CHAT_SELECTION,
	buildOneShotActionPrompt,
} from '@/lib/chat-selection'
import type { ChatEvent, UserAttachmentView } from '@/lib/chat-stream'
import { cn } from '@/lib/cn'
import { Bot, Box, Paperclip, Send } from 'lucide-react'

const FILE_MAX_BYTES = 1024 * 1024 // 1 MB per upload — plenty for markdown
const EMPTY_MESSAGES: MessageResponse[] = []
import {
	type ChangeEvent,
	type FormEvent,
	type KeyboardEvent,
	forwardRef,
	useCallback,
	useEffect,
	useImperativeHandle,
	useMemo,
	useRef,
	useState,
} from 'react'

/**
 * Imperative API for parents that render a `<Chat>` but also need to
 * reach in to start a fresh conversation (e.g. the panel's `+` button).
 */
export interface ChatHandle {
	/** Stops the current agent container, clears local transcript + selection. */
	newChat: () => void
}

export type ChatSurface = 'sheet' | 'pulse-bar'

export interface ChatProps {
	workspaceId: string
	agentActorId: string | null
	conversationId?: string | null
	surface: ChatSurface
	/**
	 * Composer-level selection. When `selection.agent` is set, the next send is
	 * routed to that agent as a one-shot session instead of the persistent
	 * agent session. Defaults to an empty selection so existing callers keep
	 * talking to the default agent.
	 */
	selection?: ChatSelection
	/**
	 * Dispatches a reducer action against the caller's selection state.
	 * Supplied alongside `selection` when the caller wants the chips' remove
	 * X buttons to update state (see `chatSelectionReducer`). When omitted
	 * the chips still render but their remove buttons are inert.
	 */
	onDispatchSelection?: (action: ChatSelectionAction) => void
	/**
	 * When provided, replaces the internal send path so the caller can
	 * intercept submit — e.g. the Pulse input bar opens the sheet and
	 * forwards the message + selection there instead of sending directly.
	 * Receives the composer content and the active selection snapshot.
	 */
	onSubmitOverride?: (content: string, selection: ChatSelection) => void | Promise<void>
	/**
	 * When this transitions from `null` to a non-empty string, the composer
	 * auto-submits that content via the normal send path exactly once. Used
	 * by the sheet to pick up a message forwarded by the Pulse input bar so
	 * the conversation "continues there". Callers must clear this (via
	 * `onAutoSendConsumed`) once they observe the consumption.
	 */
	autoSendMessage?: string | null
	/** Fired after `autoSendMessage` has been dispatched. */
	onAutoSendConsumed?: () => void
	/**
	 * Emits the merged transcript events to the parent on each change. Used by
	 * the panel's "export conversation" menu without lifting the underlying
	 * session hooks out of this component.
	 */
	onEventsChange?: (events: ChatEvent[]) => void
	className?: string
}

/**
 * Shared chat surface. Composes `<Transcript />`, `<Composer />`,
 * and the `<SelectionChips />` row, hiding the transcript in `pulse-bar` mode
 * so the same component can render as an input-only bar at the top of the
 * Pulse page and as a full-height sheet on the right-side overlay.
 *
 * Send routing (task 31):
 * - `selection.agent` set → POST a one-shot session via `useChatOneShot`,
 *   passing the message + attached object context as the action_prompt, and
 *   streams that session's logs inline as a single turn.
 * - otherwise → forwards to the persistent agent session via
 *   `useChatSession`, attaching objects (if any) as first-class attachments.
 */
export const Chat = forwardRef<ChatHandle, ChatProps>(function Chat(
	{
		workspaceId,
		agentActorId,
		conversationId,
		surface,
		selection,
		onDispatchSelection,
		onSubmitOverride,
		autoSendMessage,
		onAutoSendConsumed,
		onEventsChange,
		className,
	},
	ref,
) {
	const activeSelection = selection ?? EMPTY_CHAT_SELECTION
	const selectedAgent = activeSelection.agent
	const selectedObjects = activeSelection.objects
	const selectedNotifications = activeSelection.notifications
	const selectedFiles = activeSelection.files

	const chatSession = useChatSession({ workspaceId, agentActorId, conversationId })
	const oneShot = useChatOneShot()

	// Pre-load historical messages from the conversations API so the transcript
	// shows past turns when the user resumes a conversation. Convert each message
	// to a ChatEvent so the existing ChatTranscript can render them.
	const { data: historyData } = useConversationMessages(workspaceId, conversationId ?? null)
	// `historyData?.data` is undefined until the query resolves — fall back to
	// a stable EMPTY_MESSAGES reference rather than a fresh `[]` literal, which
	// would change identity every render and defeat useHistoricalEvents'
	// memoization (cascading into an infinite render loop via onEventsChange).
	const historicalEvents = useHistoricalEvents(historyData?.data ?? EMPTY_MESSAGES)

	// Merge events from both sources while preserving arrival order, so a turn
	// answered by the selected agent renders immediately after the user's last
	// session turn (and vice versa). Historical events from the conversations API
	// are prepended so the user sees past turns on resume.
	const liveEvents = useMergedTranscript(workspaceId, chatSession.events, oneShot.events)
	// Wrap in useMemo so the array reference only changes when inputs change.
	// Without this, the spread always produces a new reference, which makes the
	// onEventsChange useEffect fire every render → infinite setState loop.
	const events = useMemo(() => {
		if (historicalEvents.length > 0 && liveEvents.length === 0) return historicalEvents
		if (liveEvents.length > 0) return [...historicalEvents, ...liveEvents]
		return liveEvents
	}, [historicalEvents, liveEvents])

	useEffect(() => {
		onEventsChange?.(events)
	}, [events, onEventsChange])

	useImperativeHandle(
		ref,
		() => ({
			newChat: () => {
				// Front-end-only reset: the previous container keeps
				// running so any in-flight work the user kicked off there
				// completes in the background. The watchdog will pause it
				// once it goes idle.
				chatSession.reset()
				oneShot.clear()
				onDispatchSelection?.({ type: 'clear_all' })
			},
		}),
		[chatSession, oneShot, onDispatchSelection],
	)

	const showTranscript = surface === 'sheet'
	// Lazy bootstrap: the composer is usable whenever the agent actor is
	// present — the first send() call creates the container. Only disable
	// while the session is actively booting (post-create, pre-running).
	// 'closed' is intentionally excluded: when the container exits the session
	// is marked closed, but the user should still be able to send a new message
	// — chatSession.send() will bootstrap a fresh session in that case so the
	// conversation continues seamlessly. An error (e.g. the container failed to
	// start in time) also keeps the composer enabled so the user can retry —
	// the hook drops the dead session, so the next send re-bootstraps a fresh one.
	const chatBlocked = chatSession.status === 'starting'
	const oneShotBusy = oneShot.status === 'starting'
	const disabled = selectedAgent ? oneShotBusy : chatBlocked || !agentActorId
	// Show the "Connecting…" empty-state only while we're actively
	// booting a session. `idle` is now the default-empty state and shouldn't
	// trigger the connecting copy.
	const starting = !selectedAgent && chatSession.status === 'starting'
	const error = selectedAgent ? oneShot.error : chatSession.error

	const [pendingTurn, setPendingTurn] = useState(false)
	const pendingBaselineRef = useRef(0)

	// Clear pendingTurn once any assistant event lands for this turn. `result`
	// is included so turns that end without content (empty / errored) also
	// release the composer instead of stranding it.
	useEffect(() => {
		if (!pendingTurn) return
		for (let i = pendingBaselineRef.current; i < events.length; i++) {
			if (isTurnProgressEvent(events[i])) {
				setPendingTurn(false)
				return
			}
		}
	}, [pendingTurn, events])

	// Release the spinner if the underlying session/one-shot hook flips to a
	// terminal state without ever emitting a turn-progress event (e.g. stream
	// died mid-turn, container crashed on boot).
	const activeStatus = selectedAgent ? oneShot.status : chatSession.status
	useEffect(() => {
		if (!pendingTurn) return
		if (activeStatus === 'error' || activeStatus === 'closed') {
			setPendingTurn(false)
		}
	}, [pendingTurn, activeStatus])

	const handleSend = useCallback(
		async (content: string) => {
			if (onSubmitOverride) {
				// Intercept path: caller takes ownership of what happens next
				// (e.g. the Pulse bar forwards to the sheet). Skip pendingTurn
				// tracking — no session turn is in flight from this surface.
				await onSubmitOverride(content, activeSelection)
				return
			}
			pendingBaselineRef.current = events.length
			setPendingTurn(true)
			const displayAttachments = buildDisplayAttachments(activeSelection)
			const hasContext =
				selectedObjects.length > 0 || selectedNotifications.length > 0 || selectedFiles.length > 0
			try {
				if (selectedAgent) {
					// The one-shot hook builds its own action_prompt — pass raw
					// content + files so it can include them without us
					// double-enriching.
					await oneShot.send({
						workspaceId,
						agent: selectedAgent,
						content,
						objects: selectedObjects,
						notifications: selectedNotifications,
						files: selectedFiles,
						displayAttachments,
					})
				} else {
					const attachments = selectionToAttachments(selectedObjects, selectedNotifications)
					// The backend's interactive-session input endpoint currently
					// forwards only `content` to the container's stdin (attachments
					// are accepted by the schema for future first-class handling but
					// discarded at runtime). Inline the attached objects, notifications,
					// and uploaded files into the user turn so the agent actually sees
					// what the user picked.
					const enriched = hasContext
						? buildOneShotActionPrompt(
								content,
								selectedObjects,
								selectedNotifications,
								selectedFiles,
							)
						: content
					await chatSession.send(enriched, attachments, content, displayAttachments)
				}
				// Confirmed sent — clear the composer's chips so the same agent /
				// objects / notifications don't ride along on the next turn. The
				// user message bubble already displays them as context.
				onDispatchSelection?.({ type: 'clear_all' })
			} catch (err) {
				setPendingTurn(false)
				throw err
			}
		},
		[
			activeSelection,
			events.length,
			oneShot,
			onSubmitOverride,
			onDispatchSelection,
			chatSession,
			selectedAgent,
			selectedObjects,
			selectedNotifications,
			selectedFiles,
			workspaceId,
		],
	)

	// Auto-send a message forwarded from another surface (e.g. the Pulse input
	// bar opening the sheet). The ref tracks whether the *current* non-null
	// value has already been consumed; it flips back to false on each null so
	// the next transition — including an identical repeat — fires again.
	const autoSendConsumedRef = useRef(false)
	const [autoSendError, setAutoSendError] = useState<string | null>(null)
	useEffect(() => {
		if (!autoSendMessage || autoSendMessage.length === 0) {
			autoSendConsumedRef.current = false
			return
		}
		if (autoSendConsumedRef.current) return
		autoSendConsumedRef.current = true
		setAutoSendError(null)
		void handleSend(autoSendMessage).catch((err) => {
			// Session/one-shot hook errors surface via hook.error. Synchronous
			// throws before the hook sees the send (e.g. missing agentActorId,
			// api.sessions.create reject) don't — capture them here so the user
			// sees feedback instead of a silent no-op.
			setAutoSendError(err instanceof Error ? err.message : 'Failed to send')
		})
		onAutoSendConsumed?.()
	}, [autoSendMessage, handleSend, onAutoSendConsumed])

	const handleRemoveAgent = useCallback(() => {
		onDispatchSelection?.({ type: 'remove_agent' })
	}, [onDispatchSelection])

	const handleRemoveObject = useCallback(
		(id: string) => {
			onDispatchSelection?.({ type: 'remove_object', id })
		},
		[onDispatchSelection],
	)

	const handleRemoveNotification = useCallback(
		(id: string) => {
			onDispatchSelection?.({ type: 'remove_notification', id })
		},
		[onDispatchSelection],
	)

	const handleRemoveFile = useCallback(
		(name: string) => {
			onDispatchSelection?.({ type: 'remove_file', name })
		},
		[onDispatchSelection],
	)

	const placeholder = computePlaceholder(surface, selectedAgent?.name)

	return (
		<div
			className={cn(
				'flex min-h-0 flex-col gap-2',
				surface === 'sheet' ? 'h-full' : 'w-full',
				className,
			)}
			data-surface={surface}
		>
			{showTranscript && (
				<ChatTranscript
					events={events}
					starting={starting}
					pending={pendingTurn}
					error={error}
					className="min-h-0 flex-1"
				/>
			)}
			<Composer
				workspaceId={workspaceId}
				onSend={handleSend}
				disabled={disabled}
				pending={pendingTurn}
				surface={surface}
				placeholder={placeholder}
				selection={activeSelection}
				onDispatchSelection={onDispatchSelection}
				onRemoveAgent={handleRemoveAgent}
				onRemoveObject={handleRemoveObject}
				onRemoveNotification={handleRemoveNotification}
				onRemoveFile={handleRemoveFile}
				externalError={autoSendError}
				onDismissExternalError={() => setAutoSendError(null)}
			/>
		</div>
	)
})

function isTurnProgressEvent(event: ChatEvent): boolean {
	return (
		event.kind === 'text' ||
		event.kind === 'tool_use' ||
		event.kind === 'thinking' ||
		event.kind === 'result'
	)
}

/**
 * Merges the persistent chat transcript with any one-shot turns in arrival
 * order. Both hooks expose append-only event arrays, so we track how many of
 * each we've already merged and push the tail of whichever produced new
 * events since the last render.
 */
function useMergedTranscript(
	workspaceId: string,
	chatEvents: ChatEvent[],
	oneShotEvents: ChatEvent[],
): ChatEvent[] {
	const [merged, setMerged] = useState<ChatEvent[]>([])
	const chatSeenRef = useRef(0)
	const oneShotSeenRef = useRef(0)
	const workspaceRef = useRef(workspaceId)

	useEffect(() => {
		if (workspaceRef.current === workspaceId) return
		workspaceRef.current = workspaceId
		chatSeenRef.current = 0
		oneShotSeenRef.current = 0
		setMerged([])
	}, [workspaceId])

	// Handle upstream resets — e.g. the panel's "+" button which calls
	// chatSession.reset() + oneShot.clear() to start a fresh conversation, or a
	// workspace switch. When either source shrinks below what we've already
	// merged, rebuild `merged` from the current state of both sources. In the
	// common case both reset together so `merged` ends up empty; in the rare
	// single-side reset we lose strict interleaving of the remaining source,
	// which is acceptable.
	useEffect(() => {
		if (chatEvents.length < chatSeenRef.current) {
			chatSeenRef.current = chatEvents.length
			oneShotSeenRef.current = oneShotEvents.length
			setMerged([...chatEvents, ...oneShotEvents])
			return
		}
		if (chatEvents.length === chatSeenRef.current) return
		const fresh = chatEvents.slice(chatSeenRef.current)
		chatSeenRef.current = chatEvents.length
		setMerged((prev) => prev.concat(fresh))
	}, [chatEvents, oneShotEvents])

	useEffect(() => {
		if (oneShotEvents.length < oneShotSeenRef.current) {
			oneShotSeenRef.current = oneShotEvents.length
			chatSeenRef.current = chatEvents.length
			setMerged([...chatEvents, ...oneShotEvents])
			return
		}
		if (oneShotEvents.length === oneShotSeenRef.current) return
		const fresh = oneShotEvents.slice(oneShotSeenRef.current)
		oneShotSeenRef.current = oneShotEvents.length
		setMerged((prev) => prev.concat(fresh))
	}, [oneShotEvents, chatEvents])

	return merged
}

/**
 * Converts persisted conversation messages (from the conversations API) into
 * typed ChatEvent objects so ChatTranscript can render them alongside live
 * session events. Classified against the signed-in viewer, not a single fixed
 * agent id — a conversation can have several other participants (agents or
 * humans), and every one of them should render as "not me", not just the one
 * agent this panel happens to be scoped to.
 */
function useHistoricalEvents(msgs: MessageResponse[]): ChatEvent[] {
	// useMemo so the array reference only changes when data changes, not on every render.
	return useMemo(() => {
		if (msgs.length === 0) return []
		const viewerActorId = getStoredActor()?.id ?? null
		// Messages are newest-first from the API; reverse for chronological display.
		return [...msgs].reverse().map((m): ChatEvent => {
			if (viewerActorId && m.actorId === viewerActorId) {
				return { kind: 'user', text: m.content }
			}
			return { kind: 'text', text: m.content }
		})
	}, [msgs])
}

function buildDisplayAttachments(selection: ChatSelection): UserAttachmentView[] | undefined {
	const out: UserAttachmentView[] = []
	if (selection.agent) {
		out.push({ kind: 'agent', id: selection.agent.id, name: selection.agent.name ?? null })
	}
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

function selectionToAttachments(
	objects: ChatSelectionObject[],
	notifications: ChatSelectionNotification[],
): SessionInputAttachment[] | undefined {
	if (objects.length === 0 && notifications.length === 0) return undefined
	const attachments: SessionInputAttachment[] = [
		...objects.map((o) => ({ kind: 'object', id: o.id })),
		...notifications.map((n) => ({ kind: 'notification', id: n.id })),
	]
	return attachments
}

function computePlaceholder(surface: ChatSurface, agentName: string | null | undefined): string {
	if (agentName && agentName.trim().length > 0) {
		return `Message ${agentName.trim()}`
	}
	return surface === 'pulse-bar' ? 'Ask anything…' : 'Message the agent'
}

export interface ComposerProps {
	workspaceId: string
	onSend: (content: string) => Promise<void>
	disabled: boolean
	pending: boolean
	surface: ChatSurface
	placeholder: string
	selection: ChatSelection
	onDispatchSelection?: (action: ChatSelectionAction) => void
	onRemoveAgent: () => void
	onRemoveObject: (id: string) => void
	onRemoveNotification: (id: string) => void
	onRemoveFile: (name: string) => void
	externalError?: string | null
	onDismissExternalError?: () => void
	/** Forwarded as `aria-label` on the textarea. Defaults to the surface placeholder. */
	textareaLabel?: string
}

/**
 * Chat composer. Enter sends, Shift+Enter inserts a newline, IME
 * composition swallows Enter. The textarea auto-resizes up to `max-h-40` and
 * scrolls beyond that. The send button shows a Spinner (and stays disabled)
 * while a turn is pending — i.e. after a send, until the first assistant
 * event lands.
 *
 * Task 36 adds three entry points into the shared `<SlashPicker>`:
 *  - `/` typed at the start of the textarea (or immediately after whitespace)
 *    opens the picker at the top-level kind menu.
 *  - The **Agent** button opens the picker pre-filtered to the agent kind.
 *  - The **Objects** button opens the picker pre-filtered to the object kind.
 * All three share a single picker instance and an invisible `PopoverAnchor`
 * pinned to the composer so the popover always lands in the same place. When
 * a pick is committed we delete only the `/` that triggered the picker (if
 * still present) so the rest of the user's in-progress message is preserved.
 */
export function Composer({
	workspaceId,
	onSend,
	disabled,
	pending,
	surface,
	placeholder,
	selection,
	onDispatchSelection,
	onRemoveAgent,
	onRemoveObject,
	onRemoveNotification,
	onRemoveFile,
	externalError,
	onDismissExternalError,
	textareaLabel,
}: ComposerProps) {
	const [value, setValue] = useState('')
	const [sending, setSending] = useState(false)
	const [sendError, setSendError] = useState<string | null>(null)
	const [pickerOpen, setPickerOpen] = useState(false)
	const [pickerKind, setPickerKind] = useState<SlashKindId | null>(null)
	const slashPosRef = useRef<number | null>(null)
	const fileInputRef = useRef<HTMLInputElement | null>(null)
	const canSend = value.trim().length > 0 && !disabled && !sending && !pending
	const showSpinner = sending || pending

	const handleSubmit = useCallback(
		async (e?: FormEvent<HTMLFormElement>) => {
			e?.preventDefault()
			if (!canSend) return
			const content = value.trim()
			setSending(true)
			setSendError(null)
			onDismissExternalError?.()
			let sent = false
			try {
				await onSend(content)
				sent = true
			} catch (err) {
				setSendError(err instanceof Error ? err.message : 'Failed to send')
			} finally {
				setSending(false)
			}
			// Only clear the composer after the send actually resolved without
			// error — a rejected send keeps the draft so the user can retry
			// without losing a carefully crafted prompt.
			if (sent) setValue('')
		},
		[canSend, onDismissExternalError, onSend, value],
	)

	const handleKeyDown = useCallback(
		(e: KeyboardEvent<HTMLTextAreaElement>) => {
			if (e.key !== 'Enter') return
			if (e.shiftKey) return
			if (e.nativeEvent.isComposing) return
			e.preventDefault()
			void handleSubmit()
		},
		[handleSubmit],
	)

	const handleChange = useCallback((e: ChangeEvent<HTMLTextAreaElement>) => {
		const next = e.target.value
		setValue(next)
		// Open the picker when the user just typed a `/` at a qualifying
		// position: either at the very start of the input or immediately
		// after whitespace. Anything else (middle of a URL, inside a word,
		// etc.) is left alone so `/` remains a regular character.
		const pos = e.target.selectionStart
		if (typeof pos !== 'number' || pos <= 0) return
		if (next[pos - 1] !== '/') return
		const prev = pos >= 2 ? next[pos - 2] : ''
		if (prev !== '' && !/\s/.test(prev)) return
		slashPosRef.current = pos - 1
		setPickerKind(null)
		setPickerOpen(true)
	}, [])

	const openPickerForKind = useCallback((kind: SlashKindId) => {
		slashPosRef.current = null
		setPickerKind(kind)
		setPickerOpen(true)
	}, [])

	const consumeSlashTrigger = useCallback(() => {
		const pos = slashPosRef.current
		if (pos === null) return
		slashPosRef.current = null
		setValue((prev) => {
			if (prev[pos] !== '/') return prev
			return prev.slice(0, pos) + prev.slice(pos + 1)
		})
	}, [])

	const handlePickerSelect = useCallback(
		(result: SlashPickerResult) => {
			if (result.kind === 'agent') {
				onDispatchSelection?.({ type: 'add_agent', agent: result.ref })
			} else if (result.kind === 'object') {
				onDispatchSelection?.({ type: 'add_object', object: result.ref })
			} else {
				onDispatchSelection?.({ type: 'add_notification', notification: result.ref })
			}
			// The `/` that triggered the picker (if any) is dropped as soon as
			// the user commits a pick — keeping the rest of the in-progress
			// message intact.
			consumeSlashTrigger()
		},
		[onDispatchSelection, consumeSlashTrigger],
	)

	const handlePickerOpenChange = useCallback((next: boolean) => {
		setPickerOpen(next)
		if (!next) {
			setPickerKind(null)
			slashPosRef.current = null
		}
	}, [])

	const handleFileSelection = useCallback(
		async (event: ChangeEvent<HTMLInputElement>) => {
			const input = event.target
			const files = Array.from(input.files ?? [])
			input.value = '' // allow re-picking the same file after removing it
			const failures: string[] = []
			for (const file of files) {
				if (file.size > FILE_MAX_BYTES) {
					failures.push(`${file.name} is larger than ${FILE_MAX_BYTES / 1024}KB`)
					continue
				}
				try {
					const content = await file.text()
					onDispatchSelection?.({
						type: 'add_file',
						file: { name: file.name, content, sizeBytes: file.size },
					})
				} catch (err) {
					console.error(`[chat] failed to read ${file.name}`, err)
					failures.push(`Failed to read ${file.name}`)
				}
			}
			if (failures.length > 0) setSendError(failures.join('; '))
		},
		[onDispatchSelection],
	)

	return (
		<div
			className={cn(
				'relative flex flex-col gap-1 rounded-md border border-border bg-bg-surface p-2 shadow-sm',
			)}
		>
			<SlashPicker
				workspaceId={workspaceId}
				open={pickerOpen}
				onOpenChange={handlePickerOpenChange}
				onSelect={handlePickerSelect}
				selected={selection}
				initialKindId={pickerKind}
				anchor={
					<span aria-hidden className="pointer-events-none absolute left-2 bottom-2 h-0 w-0" />
				}
			/>
			<SelectionChips
				selection={selection}
				onRemoveAgent={onRemoveAgent}
				onRemoveObject={onRemoveObject}
				onRemoveNotification={onRemoveNotification}
				onRemoveFile={onRemoveFile}
			/>
			<input
				ref={fileInputRef}
				type="file"
				accept=".md,.markdown,text/markdown,text/plain"
				multiple
				className="hidden"
				onChange={(e) => void handleFileSelection(e)}
				aria-hidden
				tabIndex={-1}
			/>
			<form onSubmit={handleSubmit}>
				<Textarea
					autoResize
					value={value}
					onChange={handleChange}
					onKeyDown={handleKeyDown}
					placeholder={placeholder}
					aria-label={textareaLabel ?? placeholder}
					className="max-h-40 min-h-[36px] w-full resize-none overflow-y-auto border-0 bg-transparent p-1 text-sm focus-visible:ring-0 focus-visible:ring-offset-0"
					disabled={disabled}
					rows={1}
				/>
				{sendError || externalError ? (
					<p role="alert" className="px-1 text-error text-xs" aria-live="polite">
						{sendError ?? externalError} — your message is preserved; try again.
					</p>
				) : null}
				<div className="flex items-center gap-1">
					<Button
						type="button"
						size="sm"
						variant="ghost"
						className="h-7 gap-1 px-2 text-xs text-text-secondary"
						onClick={() => openPickerForKind('agent')}
						disabled={disabled}
						aria-label="Pick an agent"
					>
						<Bot size={14} aria-hidden />
						Agent
					</Button>
					<Button
						type="button"
						size="sm"
						variant="ghost"
						className="h-7 gap-1 px-2 text-xs text-text-secondary"
						onClick={() => openPickerForKind('item')}
						disabled={disabled}
						aria-label="Attach items"
					>
						<Box size={14} aria-hidden />
						Items
					</Button>
					<Button
						type="button"
						size="sm"
						variant="ghost"
						className="h-7 gap-1 px-2 text-xs text-text-secondary"
						onClick={() => fileInputRef.current?.click()}
						disabled={disabled}
						aria-label="Upload markdown file"
					>
						<Paperclip size={14} aria-hidden />
						Upload
					</Button>
					<div className="ml-auto">
						<Button
							type="submit"
							size="icon"
							variant="ghost"
							disabled={!canSend}
							aria-label="Send message"
						>
							{showSpinner ? <Spinner /> : <Send size={16} />}
						</Button>
					</div>
				</div>
			</form>
		</div>
	)
}
