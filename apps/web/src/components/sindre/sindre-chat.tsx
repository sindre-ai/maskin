import { SelectionChips } from '@/components/sindre/selection-chips'
import { SindreTranscript } from '@/components/sindre/sindre-transcript'
import {
	type SlashKindId,
	SlashPicker,
	type SlashPickerResult,
} from '@/components/sindre/slash-picker'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { Textarea } from '@/components/ui/textarea'
import { useSindreOneShot } from '@/hooks/use-sindre-one-shot'
import { useSindreSession } from '@/hooks/use-sindre-session'
import type { SessionInputAttachment } from '@/lib/api'
import { cn } from '@/lib/cn'
import {
	EMPTY_SINDRE_SELECTION,
	type SindreSelection,
	type SindreSelectionAction,
	type SindreSelectionNotification,
	type SindreSelectionObject,
	buildOneShotActionPrompt,
} from '@/lib/sindre-selection'
import type { SindreEvent, UserAttachmentView } from '@/lib/sindre-stream'
import { Bot, Box, Send } from 'lucide-react'
import {
	type ChangeEvent,
	type FormEvent,
	type KeyboardEvent,
	useCallback,
	useEffect,
	useRef,
	useState,
} from 'react'

export type SindreChatSurface = 'sheet' | 'pulse-bar'

export interface SindreChatProps {
	workspaceId: string
	sindreActorId: string | null
	surface: SindreChatSurface
	/**
	 * Composer-level selection. When `selection.agent` is set, the next send is
	 * routed to that agent as a one-shot session instead of the persistent
	 * Sindre session. Defaults to an empty selection so existing callers keep
	 * talking to Sindre.
	 */
	selection?: SindreSelection
	/**
	 * Dispatches a reducer action against the caller's selection state.
	 * Supplied alongside `selection` when the caller wants the chips' remove
	 * X buttons to update state (see `sindreSelectionReducer`). When omitted
	 * the chips still render but their remove buttons are inert.
	 */
	onDispatchSelection?: (action: SindreSelectionAction) => void
	/**
	 * When provided, replaces the internal send path so the caller can
	 * intercept submit — e.g. the Pulse input bar opens the sheet and
	 * forwards the message + selection there instead of sending directly.
	 * Receives the composer content and the active selection snapshot.
	 */
	onSubmitOverride?: (content: string, selection: SindreSelection) => void | Promise<void>
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
	className?: string
}

/**
 * Shared chat surface for Sindre. Composes `<Transcript />`, `<Composer />`,
 * and the `<SelectionChips />` row, hiding the transcript in `pulse-bar` mode
 * so the same component can render as an input-only bar at the top of the
 * Pulse page and as a full-height sheet on the right-side overlay.
 *
 * Send routing (task 31):
 * - `selection.agent` set → POST a one-shot session via `useSindreOneShot`,
 *   passing the message + attached object context as the action_prompt, and
 *   streams that session's logs inline as a single turn.
 * - otherwise → forwards to the persistent Sindre session via
 *   `useSindreSession`, attaching objects (if any) as first-class attachments.
 */
export function SindreChat({
	workspaceId,
	sindreActorId,
	surface,
	selection,
	onDispatchSelection,
	onSubmitOverride,
	autoSendMessage,
	onAutoSendConsumed,
	className,
}: SindreChatProps) {
	const activeSelection = selection ?? EMPTY_SINDRE_SELECTION
	const selectedAgent = activeSelection.agent
	const selectedObjects = activeSelection.objects
	const selectedNotifications = activeSelection.notifications

	const sindre = useSindreSession({ workspaceId, sindreActorId })
	const oneShot = useSindreOneShot()

	// Merge events from both sources while preserving arrival order, so a turn
	// answered by the selected agent renders immediately after the user's last
	// Sindre turn (and vice versa).
	const events = useMergedTranscript(workspaceId, sindre.events, oneShot.events)

	const showTranscript = surface === 'sheet'
	const sindreReady = sindre.status === 'ready' || sindre.status === 'connecting'
	const oneShotBusy = oneShot.status === 'starting'
	const sessionReady = selectedAgent ? !oneShotBusy : sindreReady
	const disabled = selectedAgent ? !sessionReady : !sessionReady || !sindreActorId
	const starting = !selectedAgent && (sindre.status === 'starting' || sindre.status === 'idle')
	const error = selectedAgent ? oneShot.error : sindre.error

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
			try {
				if (selectedAgent) {
					await oneShot.send({
						workspaceId,
						agent: selectedAgent,
						content,
						objects: selectedObjects,
						notifications: selectedNotifications,
						displayAttachments,
					})
				} else {
					const attachments = selectionToAttachments(selectedObjects, selectedNotifications)
					// The backend's interactive-session input endpoint currently
					// forwards only `content` to the container's stdin (attachments
					// are accepted by the schema for future first-class handling but
					// discarded at runtime). Inject a notification context block into
					// the user turn so Sindre actually sees which notification the
					// user clicked "Talk to Sindre" on. Objects remain attachment-
					// only for now so their one-shot behavior stays consistent.
					const enriched =
						selectedNotifications.length > 0
							? buildOneShotActionPrompt(content, [], selectedNotifications)
							: content
					if (attachments) {
						await sindre.send(enriched, attachments, content, displayAttachments)
					} else {
						await sindre.send(enriched, undefined, content, displayAttachments)
					}
				}
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
			sindre,
			selectedAgent,
			selectedObjects,
			selectedNotifications,
			workspaceId,
		],
	)

	// Auto-send a message forwarded from another surface (e.g. the Pulse input
	// bar opening the sheet). Guard with a ref so the same message is only
	// consumed once even if the effect re-runs before the caller clears the
	// prop.
	const autoSendConsumedRef = useRef<string | null>(null)
	useEffect(() => {
		if (!autoSendMessage || autoSendMessage.length === 0) return
		if (autoSendConsumedRef.current === autoSendMessage) return
		autoSendConsumedRef.current = autoSendMessage
		void handleSend(autoSendMessage).catch(() => {
			// Errors are surfaced through the session/one-shot hook state.
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
				<SindreTranscript
					events={events}
					starting={starting}
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
			/>
		</div>
	)
}

function isTurnProgressEvent(event: SindreEvent): boolean {
	return (
		event.kind === 'text' ||
		event.kind === 'tool_use' ||
		event.kind === 'thinking' ||
		event.kind === 'result'
	)
}

/**
 * Merges the persistent Sindre transcript with any one-shot turns in arrival
 * order. Both hooks expose append-only event arrays, so we track how many of
 * each we've already merged and push the tail of whichever produced new
 * events since the last render.
 */
function useMergedTranscript(
	workspaceId: string,
	sindreEvents: SindreEvent[],
	oneShotEvents: SindreEvent[],
): SindreEvent[] {
	const [merged, setMerged] = useState<SindreEvent[]>([])
	const sindreSeenRef = useRef(0)
	const oneShotSeenRef = useRef(0)
	const workspaceRef = useRef(workspaceId)

	useEffect(() => {
		if (workspaceRef.current === workspaceId) return
		workspaceRef.current = workspaceId
		sindreSeenRef.current = 0
		oneShotSeenRef.current = 0
		setMerged([])
	}, [workspaceId])

	// Handle upstream resets (e.g. workspace switch inside `useSindreSession`
	// that shrinks `events`). Drop our cursor to match so we don't miss a
	// future append.
	useEffect(() => {
		if (sindreEvents.length < sindreSeenRef.current) {
			sindreSeenRef.current = sindreEvents.length
			return
		}
		if (sindreEvents.length === sindreSeenRef.current) return
		const fresh = sindreEvents.slice(sindreSeenRef.current)
		sindreSeenRef.current = sindreEvents.length
		setMerged((prev) => prev.concat(fresh))
	}, [sindreEvents])

	useEffect(() => {
		if (oneShotEvents.length < oneShotSeenRef.current) {
			oneShotSeenRef.current = oneShotEvents.length
			return
		}
		if (oneShotEvents.length === oneShotSeenRef.current) return
		const fresh = oneShotEvents.slice(oneShotSeenRef.current)
		oneShotSeenRef.current = oneShotEvents.length
		setMerged((prev) => prev.concat(fresh))
	}, [oneShotEvents])

	return merged
}

function buildDisplayAttachments(selection: SindreSelection): UserAttachmentView[] | undefined {
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
	return out.length > 0 ? out : undefined
}

function selectionToAttachments(
	objects: SindreSelectionObject[],
	notifications: SindreSelectionNotification[],
): SessionInputAttachment[] | undefined {
	if (objects.length === 0 && notifications.length === 0) return undefined
	const attachments: SessionInputAttachment[] = [
		...objects.map((o) => ({ kind: 'object', id: o.id })),
		...notifications.map((n) => ({ kind: 'notification', id: n.id })),
	]
	return attachments
}

function computePlaceholder(
	surface: SindreChatSurface,
	agentName: string | null | undefined,
): string {
	if (agentName && agentName.trim().length > 0) {
		return `Message ${agentName.trim()}`
	}
	return surface === 'pulse-bar' ? 'Ask Sindre anything…' : 'Message Sindre'
}

interface ComposerProps {
	workspaceId: string
	onSend: (content: string) => Promise<void>
	disabled: boolean
	pending: boolean
	surface: SindreChatSurface
	placeholder: string
	selection: SindreSelection
	onDispatchSelection?: (action: SindreSelectionAction) => void
	onRemoveAgent: () => void
	onRemoveObject: (id: string) => void
	onRemoveNotification: (id: string) => void
}

/**
 * Chat composer for Sindre. Enter sends, Shift+Enter inserts a newline, IME
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
function Composer({
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
}: ComposerProps) {
	const [value, setValue] = useState('')
	const [sending, setSending] = useState(false)
	const [pickerOpen, setPickerOpen] = useState(false)
	const [pickerKind, setPickerKind] = useState<SlashKindId | null>(null)
	const slashPosRef = useRef<number | null>(null)
	const canSend = value.trim().length > 0 && !disabled && !sending && !pending
	const showSpinner = sending || pending

	const handleSubmit = useCallback(
		async (e?: FormEvent<HTMLFormElement>) => {
			e?.preventDefault()
			if (!canSend) return
			const content = value.trim()
			setSending(true)
			try {
				await onSend(content)
				setValue('')
			} finally {
				setSending(false)
			}
		},
		[canSend, onSend, value],
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
			} else {
				onDispatchSelection?.({ type: 'add_object', object: result.ref })
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

	return (
		<div
			className={cn(
				'relative flex flex-col gap-1 rounded-md border border-border bg-bg-surface p-2',
				surface === 'pulse-bar' && 'shadow-sm',
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
			/>
			<form onSubmit={handleSubmit} className="flex items-end gap-2">
				<Textarea
					autoResize
					value={value}
					onChange={handleChange}
					onKeyDown={handleKeyDown}
					placeholder={placeholder}
					className="max-h-40 min-h-[36px] flex-1 resize-none overflow-y-auto border-0 bg-transparent p-1 text-sm focus-visible:ring-0 focus-visible:ring-offset-0"
					disabled={disabled}
					rows={1}
				/>
				<Button
					type="submit"
					size="icon"
					variant="ghost"
					disabled={!canSend}
					aria-label="Send message"
				>
					{showSpinner ? <Spinner /> : <Send size={16} />}
				</Button>
			</form>
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
					onClick={() => openPickerForKind('object')}
					disabled={disabled}
					aria-label="Attach objects"
				>
					<Box size={14} aria-hidden />
					Objects
				</Button>
			</div>
		</div>
	)
}
