import {
	MentionPicker,
	type MentionPickerActor,
	detectMentionTrigger,
	reduceMentionPickerKey,
	buildMentionSections,
} from '@/components/chat/mention-picker'
import { SelectionChips } from '@/components/chat/selection-chips'
import {
	type SlashKindId,
	SlashPicker,
	type SlashPickerResult,
} from '@/components/chat/slash-picker'
import {
	UnifiedChatSlashPicker,
	type UnifiedChatSlashPickerHandle,
} from '@/components/chat/unified-slash-picker'
import { CreatePicker } from '@/components/shared/create-picker'
import { TypeBadge } from '@/components/shared/type-badge'
import { UploadProgress } from '@/components/shared/upload-progress'
import { Button } from '@/components/ui/button'
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Spinner } from '@/components/ui/spinner'
import { Textarea } from '@/components/ui/textarea'
import { useActors } from '@/hooks/use-actors'
import { useAvailableObjectTypes } from '@/hooks/use-available-object-types'
import { useConversationsInfinite } from '@/hooks/use-conversations'
import { useDictation } from '@/hooks/use-dictation'
import { useFeatureFlag } from '@/hooks/use-feature-flag'
import { useUploadFile } from '@/hooks/use-files'
import {
	deriveEntryAgentRole,
	trackChatMentionInserted,
	trackChatObjectReferenceCreated,
	trackSpecialistSummonedManually,
} from '@/lib/analytics'
import { getStoredActor } from '@/lib/auth'
import type { ChatSelection, ChatSelectionAction } from '@/lib/chat-selection'
import { cn } from '@/lib/cn'
import { readFileAsBase64 } from '@/lib/file-utils'
import { ArrowUp, AtSign, Box, Hash, Mic, Paperclip, Plus, Sparkles, X } from 'lucide-react'
import {
	type ChangeEvent,
	type FormEvent,
	type KeyboardEvent,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from 'react'

export type ChatSurface = 'sheet' | 'pulse-bar'

interface PendingUpload {
	tempId: string
	name: string
	sizeBytes: number
	mimeType?: string
	status: 'uploading' | 'failed'
	progress: number
	error?: string
}

function makeTempId() {
	return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
		? crypto.randomUUID()
		: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

// The three built-in NEWKIND labels that can promote to a type-filter chip when
// typed as `/task ` / `/bet ` / `/insight `. Any custom workspace type falls
// through as a normal search query — hardcoded per spec §Create-new rows.
const CHAT_NEWKIND_LABELS: ReadonlySet<string> = new Set(['task', 'bet', 'insight'])

// Trigger regex verbatim from the spec §Interaction details: `/` at input start
// or after whitespace, capturing the word-char query up to the caret.
const UNIFIED_SLASH_TRIGGER_RE = /(?:^|\s)\/([\w-]*)$/

/**
 * Pure state machine for the `/` composer trigger. Called on every keystroke
 * inside the textarea when the `chat-slash-picker-v2` flag is on. Returns one
 * of four verdicts:
 *
 *  - `open`: user just typed `/` at a word boundary. `slashStart` is the
 *    index of that `/`.
 *  - `promote_to_chip`: the picker was already open and the text now ends
 *    with `/<label> ` where label is one of {task,bet,insight}. `nextValue`
 *    is the composer text with the `/label ` slice removed; `nextSlashStart`
 *    is the new `/` position (`null` when the picker should close and no new
 *    trigger is left in the text). Picker stays open, chip is set, both
 *    sections narrow.
 *  - `close`: the picker was open and something invalidated the trigger
 *    (the `/` is gone, the caret drifted before it, etc.).
 *  - `noop`: nothing to change — either the picker wasn't tracking or the
 *    user is just typing more query chars.
 */
type UnifiedSlashOutcome =
	| { type: 'noop' }
	| { type: 'open'; slashStart: number }
	| { type: 'close' }
	| {
			type: 'promote_to_chip'
			objectType: string
			nextValue: string
			nextSlashStart: number | null
			nextCaret: number
	  }

export function detectUnifiedSlashTransition({
	next,
	pos,
	slashStart,
	typeFilterChip,
}: {
	next: string
	pos: number
	slashStart: number | null
	typeFilterChip: string | null
}): UnifiedSlashOutcome {
	// Chip already set — the picker is scoped and further `/` typing is just
	// query text; we don't promote a second time.
	if (typeFilterChip === null && slashStart !== null) {
		// Detect `/<label> ` transformation. Only fires when the current run
		// starts at slashStart and the last char is a space.
		const runFromSlash = next.slice(slashStart, pos)
		const promote = /^\/(task|bet|insight) $/.exec(runFromSlash)
		if (promote) {
			const objectType = promote[1]
			// Splice the `/label ` slice out of the composer. The tail (from
			// `pos` on) stays put; caret goes to slashStart.
			const nextValue = next.slice(0, slashStart) + next.slice(pos)
			return {
				type: 'promote_to_chip',
				objectType,
				nextValue,
				nextSlashStart: null,
				nextCaret: slashStart,
			}
		}
	}

	// Recognise a fresh `/` trigger at a word boundary.
	const uptoCaret = next.slice(0, pos)
	const match = UNIFIED_SLASH_TRIGGER_RE.exec(uptoCaret)
	if (match) {
		// Match index is where `(?:^|\s)` matched — the `/` is one char in.
		const rawStart = match.index
		const slashIndex = rawStart === 0 && match[0][0] === '/' ? 0 : rawStart + 1
		if (slashStart === slashIndex) return { type: 'noop' }
		return { type: 'open', slashStart: slashIndex }
	}

	// No trigger matched, but the picker is currently open — the trigger's
	// `/` was deleted or the caret drifted before it; close.
	if (slashStart !== null) return { type: 'close' }
	return { type: 'noop' }
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
	onRemoveAgent: (id: string) => void
	onRemoveObject: (id: string) => void
	onRemoveNotification: (id: string) => void
	onRemoveFile: (fileId: string) => void
	externalError?: string | null
	onDismissExternalError?: () => void
	/**
	 * The active conversation's participant actor ids — used to seed the
	 * `In this conversation` section of the `@` mention picker. Callers wiring
	 * a brand-new-chat surface pass `[]`; the picker falls through to the
	 * `Recent collaborators` walk instead.
	 */
	conversationParticipantIds?: string[]
	/** Forwarded as `aria-label` on the textarea. Defaults to the surface placeholder. */
	textareaLabel?: string
	/** Optional controlled draft. Supply both to let a caller prefill the
	 *  composer (the chats zero-state suggestion rows); omit both to keep the
	 *  composer's own internal state. */
	value?: string
	onValueChange?: (value: string) => void
}

/**
 * Chat composer. Enter sends, Shift+Enter inserts a newline, IME
 * composition swallows Enter. The textarea auto-resizes up to `max-h-40` and
 * scrolls beyond that. The send button shows a Spinner (and stays disabled)
 * while a turn is pending — i.e. after a send, until the caller flips
 * `pending` back to false.
 *
 * Entry points into pickers:
 *  - `/` typed at a word boundary opens the "Turn this into" dropdown.
 *  - `@` typed at a word boundary opens the mention picker (agents + humans)
 *    inline at the caret; ↑↓ navigate, ↵ inserts, Escape closes. Textarea
 *    keeps DOM focus while the picker is open.
 *  - The `+` menu opens the shared `<SlashPicker>` for object references and
 *    "Mention an agent" (an alternate path to the same mention flow).
 */
export function Composer({
	workspaceId,
	onSend,
	disabled,
	pending,
	placeholder,
	selection,
	onDispatchSelection,
	onRemoveAgent,
	onRemoveObject,
	onRemoveNotification,
	onRemoveFile,
	externalError,
	onDismissExternalError,
	conversationParticipantIds,
	textareaLabel,
	value: controlledValue,
	onValueChange,
}: ComposerProps) {
	const [internalValue, setInternalValue] = useState('')
	const value = controlledValue ?? internalValue
	// Mirrors `value` for the functional-update path — a controlled caller has
	// no state for us to read back synchronously.
	const valueRef = useRef(value)
	valueRef.current = value
	const setValue = useCallback(
		(updater: string | ((prev: string) => string)) => {
			const next = typeof updater === 'function' ? updater(valueRef.current) : updater
			valueRef.current = next
			if (controlledValue === undefined) setInternalValue(next)
			onValueChange?.(next)
		},
		[controlledValue, onValueChange],
	)
	const [sending, setSending] = useState(false)
	const [sendError, setSendError] = useState<string | null>(null)
	const [pickerOpen, setPickerOpen] = useState(false)
	const [pickerKind, setPickerKind] = useState<SlashKindId | null>(null)
	// v2 unified `/` picker state (gated by `chat-slash-picker-v2`). `slashStart`
	// points at the `/` in the textarea; when set, everything after it up to the
	// caret is the picker's live query. `typeFilterChip` is the NEWKIND label
	// (e.g. 'task') the user promoted by typing `/task ` — it lives outside the
	// text as a first-class composer chip and narrows both picker sections.
	const unifiedPickerEnabled = useFeatureFlag('chat-slash-picker-v2')
	const [unifiedOpen, setUnifiedOpen] = useState(false)
	const [slashStart, setSlashStart] = useState<number | null>(null)
	const [typeFilterChip, setTypeFilterChip] = useState<string | null>(null)
	// The picker's active row id — the textarea publishes this as its
	// `aria-activedescendant` so screen readers announce the highlighted row
	// while the composer keeps DOM focus (spec §Accessibility). Set by the
	// picker via `onActiveDescendantChange`; null when no row is active.
	const [unifiedActiveDescendant, setUnifiedActiveDescendant] = useState<string | null>(null)
	// Imperative handle: arrow keys and Enter reach the picker through this
	// ref rather than by bubbling from the textarea to a Portal that isn't
	// its DOM ancestor.
	const unifiedPickerRef = useRef<UnifiedChatSlashPickerHandle | null>(null)
	// Seed title captured on a create-row select — threaded into `<CreatePicker>`
	// as `defaultText` so the user doesn't retype the query they just typed
	// (spec's "never dead-ends" contract).
	const [createSeedTitle, setCreateSeedTitle] = useState<string>('')
	// In-flight + failed uploads. Only the resolved fileId enters `ChatSelection`
	// (high-frequency upload events would otherwise churn the selection reducer);
	// these are the chips shown while bytes are still transferring or after the
	// upload failed, removable in either state.
	const [pendingUploads, setPendingUploads] = useState<PendingUpload[]>([])
	const slashPosRef = useRef<number | null>(null)
	// Position of the `@` that opened the mention picker and the query text
	// after it. Both null when the picker isn't in `@`-typing mode.
	const [mentionTrigger, setMentionTrigger] = useState<{ atPos: number; query: string } | null>(
		null,
	)
	const [mentionHighlightIndex, setMentionHighlightIndex] = useState(0)
	const fileInputRef = useRef<HTMLInputElement | null>(null)
	const textareaRef = useRef<HTMLTextAreaElement | null>(null)
	// `/` opens the create list (mockup 761–771). The chosen type seeds the
	// shipped create surface; the mockup's FROM-THIS-CHAT panel additionally
	// pre-fills the name/fields from the conversation, which needs a `seed`
	// prop on <CreatePicker> that doesn't exist yet — see the composer note
	// where it is rendered.
	const [createOpen, setCreateOpen] = useState(false)
	const [createSubtype, setCreateSubtype] = useState<string | undefined>(undefined)
	const [turnIntoOpen, setTurnIntoOpen] = useState(false)
	const objectTypes = useAvailableObjectTypes()
	// Gates the `+` DropdownMenu collapse (task 6321aecf). OFF preserves the
	// three-item Reference / Mention / Create menu; ON renders the single
	// Attach a file row that triggers the same fileInputRef the standalone
	// Paperclip button uses.
	const plusMenuAttachOnly = useFeatureFlag('chat-plus-menu-attach-only')
	const abortControllersRef = useRef<Map<string, AbortController>>(new Map())
	const uploadFile = useUploadFile(workspaceId)
	const selfActor = getStoredActor()
	const selfActorId = selfActor?.id ?? null

	// Pool for the mention picker — cached workspace actors. `useActors` uses
	// the same query key as every other surface in the app so the picker opens
	// against warm data (spec: `list_actors({ workspace_id, limit: 100 })` on
	// chat mount, cached for the session).
	const { data: workspaceActors } = useActors(workspaceId, { enabled: true })
	const mentionActors = useMemo<MentionPickerActor[]>(
		() =>
			(workspaceActors ?? [])
				// role !== "system" — filter out Google Calendar / Gmail / Slack / GitHub / Ubersuggest.
				.filter((a) => !a.isSystem)
				.map((a) => ({
					id: a.id,
					name: a.name,
					type: a.type,
					description: a.description,
					email: a.email,
				})),
		[workspaceActors],
	)
	const { data: conversationPages } = useConversationsInfinite(workspaceId)
	const conversationList = useMemo(
		() => conversationPages?.pages.flatMap((p) => p.conversations) ?? [],
		[conversationPages],
	)
	const mentionSections = useMemo(
		() =>
			buildMentionSections({
				actors: mentionActors,
				conversations: conversationList,
				conversationParticipantIds: conversationParticipantIds ?? [],
				query: mentionTrigger?.query ?? '',
				selfActorId,
			}),
		[
			mentionActors,
			conversationList,
			conversationParticipantIds,
			mentionTrigger?.query,
			selfActorId,
		],
	)
	const mentionFlatRows = useMemo(
		() => mentionSections.flatMap((s) => s.rows),
		[mentionSections],
	)
	// The picker's own highlightIndex resets whenever the flat list changes;
	// re-anchor at 0 so the composer's ↵ never fires against a stale row.
	// biome-ignore lint/correctness/useExhaustiveDependencies: the length is what drives the reset, not the identity of the rows array.
	useEffect(() => {
		setMentionHighlightIndex(0)
	}, [mentionFlatRows.length])

	const dictation = useDictation(
		useCallback(
			(text: string) => {
				setValue((prev) => (prev.length === 0 ? text : `${prev.trimEnd()} ${text}`))
			},
			[setValue],
		),
	)

	// Abort every in-flight upload when the composer unmounts so a closed
	// chat surface doesn't leave XHRs hanging (and doesn't race-dispatch
	// add_file into a selection state that's already been thrown away).
	useEffect(() => {
		const controllers = abortControllersRef.current
		return () => {
			for (const controller of controllers.values()) controller.abort()
			controllers.clear()
		}
	}, [])
	// Block send while any attachment is still uploading or has failed — the
	// user must let it resolve or remove it (AC-T3). Mirrors the comment input's
	// rule that send requires every chip to be in a final, sendable state.
	const canSend =
		value.trim().length > 0 && !disabled && !sending && !pending && pendingUploads.length === 0
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
		[canSend, onDismissExternalError, onSend, setValue, value],
	)

	// Commits the picker's highlighted row into a mention pill: strips the
	// in-progress `@query` from the textarea, dispatches `add_agent` into the
	// selection reducer, and fires the `chat_mention_inserted` analytics event
	// tagged with `kind` (agent | human). The composer never loses DOM focus
	// while the picker is open, so the caret snaps back to where the `@` was.
	const commitMention = useCallback(
		(actor: MentionPickerActor & { kind: 'agent' | 'human' }) => {
			const trigger = mentionTrigger
			if (!trigger) return
			const textarea = textareaRef.current
			setValue((prev) => {
				const before = prev.slice(0, trigger.atPos)
				const after = prev.slice(trigger.atPos + 1 + trigger.query.length)
				const trimmedAfter = after.startsWith(' ') ? after : ` ${after}`
				const next = `${before}${trimmedAfter}`
				requestAnimationFrame(() => {
					const caret = before.length + 1 // land the caret past the leading space we inserted
					textarea?.focus()
					textarea?.setSelectionRange(caret, caret)
				})
				return next
			})
			onDispatchSelection?.({ type: 'add_agent', agent: { id: actor.id, name: actor.name } })
			trackChatMentionInserted({
				entity_id: actor.id,
				entity_type: 'actor',
				kind: actor.kind,
			})
			setMentionTrigger(null)
		},
		[mentionTrigger, onDispatchSelection, setValue],
	)

	const handleKeyDown = useCallback(
		(e: KeyboardEvent<HTMLTextAreaElement>) => {
			// While the mention picker is open, route arrow keys / Enter / Escape
			// through the picker so keyboard nav works without the composer losing
			// focus. Non-picker keys fall through to the standard textarea handling.
			if (mentionTrigger) {
				const result = reduceMentionPickerKey(
					{ key: e.key },
					{ flatCount: mentionFlatRows.length, highlightIndex: mentionHighlightIndex },
				)
				if (result.handled) {
					if (result.preventDefault) e.preventDefault()
					if (result.action?.type === 'move') setMentionHighlightIndex(result.action.nextIndex)
					else if (result.action?.type === 'commit') {
						const target = mentionFlatRows[result.action.index]
						if (target) {
							commitMention({
								...target,
								kind: target.type === 'agent' ? 'agent' : 'human',
							})
						}
					} else if (result.action?.type === 'close') {
						setMentionTrigger(null)
					}
					return
				}
			}
			// v2 chip lives outside the text — Backspace on an empty composer
			// with a chip set clears the chip (spec §Interaction details).
			if (
				unifiedPickerEnabled &&
				e.key === 'Backspace' &&
				typeFilterChip !== null &&
				value.length === 0
			) {
				e.preventDefault()
				setTypeFilterChip(null)
				return
			}
			// While the unified picker is open, ↑↓ move its active row and ↵
			// selects it — routed through the imperative handle because focus
			// stays on the textarea and the picker Portal isn't a DOM ancestor.
			if (unifiedPickerEnabled && unifiedOpen) {
				if (e.key === 'ArrowDown') {
					e.preventDefault()
					unifiedPickerRef.current?.moveActive(1)
					return
				}
				if (e.key === 'ArrowUp') {
					e.preventDefault()
					unifiedPickerRef.current?.moveActive(-1)
					return
				}
			}
			// Escape closes the unified picker without touching the composer text
			// or the chip; the trigger char stays so the user can continue.
			if (unifiedPickerEnabled && e.key === 'Escape' && unifiedOpen) {
				e.preventDefault()
				setUnifiedOpen(false)
				setSlashStart(null)
				return
			}
			if (e.key !== 'Enter') return
			if (e.shiftKey) return
			if (e.nativeEvent.isComposing) return
			// Enter fires the picker's active row while the picker is open. If
			// there's no active row (empty list), swallow Enter rather than
			// submitting — the visual state promises a selection is pending.
			if (unifiedPickerEnabled && unifiedOpen) {
				e.preventDefault()
				unifiedPickerRef.current?.selectActive()
				return
			}
			e.preventDefault()
			void handleSubmit()
		},
		[
			handleSubmit,
			unifiedPickerEnabled,
			unifiedOpen,
			typeFilterChip,
			value.length,
			mentionTrigger,
			mentionFlatRows,
			mentionHighlightIndex,
			commitMention,
		],
	)

	const handleChange = useCallback(
		(e: ChangeEvent<HTMLTextAreaElement>) => {
			const next = e.target.value
			setValue(next)
			const pos = e.target.selectionStart
			if (typeof pos !== 'number' || pos < 0) {
				setMentionTrigger(null)
				return
			}

			// `@`-in-composer opens the mention picker whenever the regex from the
			// acceptance criteria matches the text up to the caret. This also
			// keeps the picker open across further typing that stays inside a word
			// after the `@` — the query updates, the picker filters. Clears any
			// competing `/` picker anchor so the two pickers can't fight over the
			// same trigger.
			const mention = detectMentionTrigger(next, pos)
			if (mention) {
				setMentionTrigger(mention)
				setTurnIntoOpen(false)
				slashPosRef.current = null
				if (unifiedPickerEnabled) {
					setUnifiedOpen(false)
					setSlashStart(null)
				}
				return
			}
			setMentionTrigger(null)

			// v2: the top-level `/` path routes to `<UnifiedChatSlashPicker>`
			// (Reference on top, Create-new below). The legacy `turnIntoOpen`
			// create dropdown stays only under the `+` menu's "Create an object"
			// entry, so a rollback of the flag flips this composer straight back
			// to today's shape. Root-cause per Architect tech spec / task body:
			// the current path opens `turnIntoOpen` at line 215–232 and never
			// invokes the picker; that's what this branch replaces.
			if (unifiedPickerEnabled) {
				const outcome = detectUnifiedSlashTransition({
					next,
					pos,
					slashStart,
					typeFilterChip,
				})
				if (outcome.type === 'promote_to_chip') {
					// `/task ` transformed → the raw label is stripped from the
					// textarea and the chip is set. Picker stays open with the
					// query cleared and the type filter narrowing both sections.
					setValue(outcome.nextValue)
					setSlashStart(outcome.nextSlashStart)
					setTypeFilterChip(outcome.objectType)
					setUnifiedOpen(true)
					// Restore caret to right after the removed `/label ` so a
					// follow-up keystroke lands where the user expects.
					requestAnimationFrame(() => {
						const el = textareaRef.current
						if (el) el.setSelectionRange(outcome.nextCaret, outcome.nextCaret)
					})
					return
				}
				if (outcome.type === 'open') {
					setSlashStart(outcome.slashStart)
					setUnifiedOpen(true)
					return
				}
				if (outcome.type === 'close') {
					setSlashStart(null)
					setUnifiedOpen(false)
					return
				}
				// `outcome.type === 'noop'` — either not triggering, or already
				// tracking the same `/` and the user is just typing more chars.
				return
			}

			// Legacy path — pre-v2 behaviour, unchanged: `/` at a word boundary
			// opens the create-only dropdown.
			if (pos <= 0) return
			if (next[pos - 1] !== '/') return
			const prev = pos >= 2 ? next[pos - 2] : ''
			if (prev !== '' && !/\s/.test(prev)) return
			slashPosRef.current = pos - 1
			setTurnIntoOpen(true)
		},
		[setValue, unifiedPickerEnabled, slashStart, typeFilterChip],
	)

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
	}, [setValue])

	const openCreateFor = useCallback(
		(subtype: string | undefined) => {
			setCreateSubtype(subtype)
			setCreateSeedTitle('')
			setTurnIntoOpen(false)
			consumeSlashTrigger()
			setCreateOpen(true)
		},
		[consumeSlashTrigger],
	)

	const handlePickerSelect = useCallback(
		(result: SlashPickerResult) => {
			if (result.kind === 'agent') {
				onDispatchSelection?.({ type: 'add_agent', agent: result.ref })
				// Thinness event #2: the owner bypassed the default (Chief of
				// Staff, once T3 wires it) and pulled a specialist in directly.
				// The parent bet counts any hit as evidence the boundary agent
				// isn't holding.
				trackSpecialistSummonedManually({
					entity_id: result.ref.id,
					entity_type: 'agent',
					agent_role: deriveEntryAgentRole(result.ref.name),
				})
				// The `+` menu → "Mention an agent" path also counts as a mention insertion.
				trackChatMentionInserted({
					entity_id: result.ref.id,
					entity_type: 'actor',
					kind: 'agent',
				})
			} else if (result.kind === 'object') {
				onDispatchSelection?.({ type: 'add_object', object: result.ref })
				trackChatObjectReferenceCreated({
					entity_id: result.ref.id,
					object_type: result.ref.type ?? 'object',
				})
			} else if (result.kind === 'notification') {
				onDispatchSelection?.({ type: 'add_notification', notification: result.ref })
				trackChatObjectReferenceCreated({
					entity_id: result.ref.id,
					object_type: 'notification',
				})
			} else if (result.kind === 'create') {
				// The `create` kind is surfaced by the unified `/` picker via a
				// dedicated handler below — the legacy picker never emits it, so
				// the legacy path here is a no-op. Keeping the switch exhaustive
				// keeps the discriminated union honest for future callers.
			}
			// The `/` that triggered the picker (if any) is dropped as soon as
			// the user commits a pick — keeping the rest of the in-progress
			// message intact.
			consumeSlashTrigger()
		},
		[onDispatchSelection, consumeSlashTrigger],
	)

	// Compute the picker's live query — text from the char AFTER the `/` up to
	// the current caret. Falls back to '' when the picker is closed or the
	// user has typed nothing after the trigger.
	const unifiedQuery = useMemo(() => {
		if (!unifiedOpen || slashStart === null) return ''
		return value.slice(slashStart + 1)
	}, [unifiedOpen, slashStart, value])

	// Consumes the `/<query>` slice from the textarea after a pick, restoring
	// the caret to the position where the trigger used to be. The type-filter
	// chip stays until the user explicitly clears it (backspace / X) — the
	// spec treats it as a first-class composer chip.
	const consumeUnifiedSlashRange = useCallback(() => {
		if (slashStart === null) return
		const start = slashStart
		setValue((prev) => {
			// Delete from the `/` at slashStart through the end (query slice).
			// The picker's own layout is caret-anchored, so the caret is always
			// at the end of the value here — no need to compute a separate end.
			return prev.slice(0, start)
		})
		setSlashStart(null)
		requestAnimationFrame(() => {
			const el = textareaRef.current
			if (el) el.setSelectionRange(start, start)
		})
	}, [slashStart, setValue])

	const handleUnifiedSelect = useCallback(
		(selection: {
			kind: 'reference' | 'create'
			object?: { id: string; title?: string | null; type?: string | null }
			objectType?: string
			seedTitle?: string
		}) => {
			if (selection.kind === 'reference' && selection.object) {
				const object = {
					id: selection.object.id,
					title: selection.object.title ?? null,
					type: selection.object.type ?? null,
				}
				onDispatchSelection?.({ type: 'add_object', object })
				trackChatObjectReferenceCreated({
					entity_id: object.id,
					object_type: object.type ?? 'object',
				})
				consumeUnifiedSlashRange()
				setUnifiedOpen(false)
				return
			}
			if (selection.kind === 'create' && selection.objectType) {
				// Existing create-object flow, seeded with the query the user just
				// typed so the create form opens with the title pre-populated
				// (spec's "never dead-ends" contract — the user must not retype
				// what they just typed).
				const seed = selection.seedTitle?.trim() ?? ''
				consumeUnifiedSlashRange()
				setUnifiedOpen(false)
				setCreateSubtype(selection.objectType)
				setCreateSeedTitle(seed)
				setCreateOpen(true)
			}
		},
		[onDispatchSelection, consumeUnifiedSlashRange],
	)

	const handleUnifiedOpenChange = useCallback((next: boolean) => {
		setUnifiedOpen(next)
		if (!next) {
			// Leaving the picker cleans up its state but leaves the composer
			// text alone — the `/` and any typed query stay so the user can
			// pick up where they left off. Chip persists too; the user is
			// still authoring in that scope.
			setSlashStart(null)
		}
	}, [])

	const handlePickerOpenChange = useCallback((next: boolean) => {
		setPickerOpen(next)
		if (!next) {
			setPickerKind(null)
			slashPosRef.current = null
		}
	}, [])

	const uploadPickedFile = useCallback(
		async (tempId: string, file: File) => {
			const controller = new AbortController()
			abortControllersRef.current.set(tempId, controller)
			try {
				const content = await readFileAsBase64(file)
				const created = await uploadFile(
					{
						name: file.name,
						mime_type: file.type || 'application/octet-stream',
						content,
						encoding: 'base64',
					},
					{
						signal: controller.signal,
						onProgress: (progress) => {
							setPendingUploads((prev) =>
								prev.map((p) => (p.tempId === tempId ? { ...p, progress } : p)),
							)
						},
					},
				)
				// Cancel-vs-resolve race: if the user removed the chip between the
				// XHR completing on the wire and this microtask firing, the chip is
				// already gone and the abort fired — don't dispatch add_file so the
				// user's intent is honoured (closes T4 reviewer SHOULD).
				if (controller.signal.aborted) return
				console.info(
					'[chat] uploaded attachment',
					JSON.stringify({
						fileId: created.id,
						name: file.name,
						sizeBytes: file.size,
						mimeType: file.type || 'application/octet-stream',
					}),
				)
				setPendingUploads((prev) => prev.filter((p) => p.tempId !== tempId))
				onDispatchSelection?.({
					type: 'add_file',
					file: {
						fileId: created.id,
						name: file.name,
						sizeBytes: file.size,
						mimeType: file.type || undefined,
					},
				})
			} catch (err) {
				// An aborted upload was a user-initiated cancel — the pending row
				// has already been removed by handleRemovePending; nothing to
				// surface and no error state to set.
				if (controller.signal.aborted) return
				console.error(`[chat] failed to upload ${file.name}`, err)
				const message = err instanceof Error ? err.message : 'Upload failed'
				// Mirror the comment input: the failed chip stays put so the user
				// can see which attachment broke and remove it. Send stays blocked
				// (via canSend) until every pending row is resolved or removed.
				setPendingUploads((prev) =>
					prev.map((p) => (p.tempId === tempId ? { ...p, status: 'failed', error: message } : p)),
				)
			} finally {
				abortControllersRef.current.delete(tempId)
			}
		},
		[uploadFile, onDispatchSelection],
	)

	const handleFileSelection = useCallback(
		(event: ChangeEvent<HTMLInputElement>) => {
			const input = event.target
			const files = Array.from(input.files ?? [])
			input.value = '' // allow re-picking the same file after removing it
			const additions: PendingUpload[] = files.map((file) => ({
				tempId: makeTempId(),
				name: file.name,
				sizeBytes: file.size,
				mimeType: file.type || undefined,
				status: 'uploading',
				progress: 0,
			}))
			if (additions.length === 0) return
			setPendingUploads((prev) => [...prev, ...additions])
			additions.forEach((p, idx) => {
				void uploadPickedFile(p.tempId, files[idx])
			})
		},
		[uploadPickedFile],
	)

	const handleRemovePending = useCallback((tempId: string) => {
		// Abort first so the in-flight XHR is cancelled before the request can
		// finish on the server. uploadPickedFile's catch branch sees
		// signal.aborted=true and skips the error toast; the file row never
		// gets created in the backend (AC-T4).
		abortControllersRef.current.get(tempId)?.abort()
		abortControllersRef.current.delete(tempId)
		setPendingUploads((prev) => prev.filter((p) => p.tempId !== tempId))
	}, [])

	return (
		<div
			className={cn(
				'relative mx-auto flex w-full max-w-[860px] flex-col gap-1 rounded-2xl border border-input bg-card px-3 py-2.5 shadow-sm',
			)}
		>
			<SlashPicker
				workspaceId={workspaceId}
				open={pickerOpen}
				onOpenChange={handlePickerOpenChange}
				onSelect={handlePickerSelect}
				selected={{
					agents: selection.agents,
					objects: selection.objects,
					notifications: selection.notifications,
				}}
				initialKindId={pickerKind}
				anchor={
					<span aria-hidden className="pointer-events-none absolute left-2 bottom-2 h-0 w-0" />
				}
			/>
			{unifiedPickerEnabled ? (
				<UnifiedChatSlashPicker
					ref={unifiedPickerRef}
					workspaceId={workspaceId}
					open={unifiedOpen}
					onOpenChange={handleUnifiedOpenChange}
					query={unifiedQuery}
					typeFilter={typeFilterChip}
					onSelect={handleUnifiedSelect}
					onActiveDescendantChange={setUnifiedActiveDescendant}
					anchor={
						<span aria-hidden className="pointer-events-none absolute left-2 bottom-2 h-0 w-0" />
					}
				/>
			) : null}
			{unifiedPickerEnabled && typeFilterChip !== null ? (
				<ul className="flex list-none flex-wrap items-center gap-1 p-0" aria-label="Type filter">
					<li className="inline-flex items-center gap-1 rounded-full border border-brand/40 bg-brand/10 px-2 py-0.5 text-xs font-semibold text-brand">
						<Hash size={12} aria-hidden />
						<span>{typeFilterChip}</span>
						<button
							type="button"
							onClick={() => setTypeFilterChip(null)}
							aria-label={`Clear ${typeFilterChip} filter`}
							className="-mr-0.5 inline-flex h-4 w-4 items-center justify-center rounded-full text-brand hover:bg-brand/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
						>
							<X size={10} aria-hidden />
						</button>
					</li>
				</ul>
			) : null}
			{/* Inline `@` mention picker — the composer's textarea remains the
			    focused element, and the picker consumes arrow keys / Enter /
			    Escape via `handleKeyDown`'s `reduceMentionPickerKey` branch. */}
			<MentionPicker
				open={mentionTrigger !== null}
				onOpenChange={(next) => {
					if (!next) setMentionTrigger(null)
				}}
				actors={mentionActors}
				conversationParticipantIds={conversationParticipantIds ?? []}
				query={mentionTrigger?.query ?? ''}
				workspaceId={workspaceId}
				selfActorId={selfActorId}
				onSelect={(actor) => commitMention(actor)}
				anchor={
					<span aria-hidden className="pointer-events-none absolute left-2 bottom-2 h-0 w-0" />
				}
			/>
			{/* A DropdownMenu rather than a Popover: `/` opens this without a click,
			    so the list has to be reachable from the keyboard. Radix gives the
			    menu roving focus, arrow keys and typeahead for free — the Popover
			    this replaced left focus in the textarea with no way in. */}
			<DropdownMenu
				open={turnIntoOpen}
				onOpenChange={(next) => {
					setTurnIntoOpen(next)
					if (!next) slashPosRef.current = null
				}}
			>
				<DropdownMenuTrigger asChild>
					<span aria-hidden className="pointer-events-none absolute bottom-2 left-2 h-0 w-0" />
				</DropdownMenuTrigger>
				<DropdownMenuContent
					align="start"
					side="top"
					sideOffset={8}
					className="w-[320px]"
					// The visible DropdownMenuLabel below is not an accessible name
					// for the menu itself — name it explicitly so the list is
					// announced (and addressable) as "Turn this into an object".
					aria-label="Turn this into an object"
					// Radix returns focus to the trigger, which here is an invisible
					// anchor — send the caret back to the composer instead.
					onCloseAutoFocus={(e) => {
						e.preventDefault()
						textareaRef.current?.focus()
					}}
				>
					<DropdownMenuLabel className="eyebrow">Turn this into an object</DropdownMenuLabel>
					{objectTypes.map((type) => (
						<DropdownMenuItem
							key={type.value}
							onSelect={() => openCreateFor(type.value)}
							className="gap-2.5"
						>
							<TypeBadge type={type.value} variant="tile" />
							<span className="min-w-0 flex-1 truncate text-[12.5px] font-semibold">
								{type.label}
							</span>
						</DropdownMenuItem>
					))}
				</DropdownMenuContent>
			</DropdownMenu>
			<SelectionChips
				selection={selection}
				onRemoveAgent={onRemoveAgent}
				onRemoveObject={onRemoveObject}
				onRemoveNotification={onRemoveNotification}
				onRemoveFile={onRemoveFile}
				selfActorId={selfActorId}
			/>
			{pendingUploads.length > 0 && (
				<ul
					className="flex list-none flex-wrap items-center gap-1 p-0"
					aria-label="Uploading attachments"
				>
					{pendingUploads.map((p) => (
						<li
							key={p.tempId}
							data-upload-status={p.status}
							className={cn(
								'inline-flex max-w-full items-center gap-1 rounded-full border bg-card px-2 py-0.5 text-xs text-foreground',
								p.status === 'failed' ? 'border-error' : 'border-border',
							)}
						>
							<UploadProgress
								progress={p.progress}
								status={p.status}
								error={p.error}
								className="shrink-0"
							/>
							<span className="max-w-[12rem] truncate text-muted-foreground">{p.name}</span>
							<button
								type="button"
								onClick={() => handleRemovePending(p.tempId)}
								aria-label={
									p.status === 'failed'
										? `Remove failed upload ${p.name}`
										: `Cancel upload ${p.name}`
								}
								className="-mr-0.5 inline-flex h-4 w-4 items-center justify-center rounded-full text-muted-foreground hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
							>
								<X size={10} aria-hidden />
							</button>
						</li>
					))}
				</ul>
			)}
			<input
				ref={fileInputRef}
				type="file"
				multiple
				className="hidden"
				onChange={handleFileSelection}
				aria-hidden
				tabIndex={-1}
			/>
			<form onSubmit={handleSubmit}>
				<Textarea
					autoResize
					ref={textareaRef}
					value={value}
					onChange={handleChange}
					onKeyDown={handleKeyDown}
					placeholder={placeholder}
					className="max-h-40 min-h-[36px] w-full resize-none overflow-y-auto border-0 bg-transparent p-1 text-sm focus-visible:ring-0 focus-visible:ring-offset-0"
					disabled={disabled}
					rows={1}
					aria-label={textareaLabel}
					// Screen readers announce the picker's active row while focus
					// stays on the textarea (spec §Accessibility). The picker
					// keeps this in sync via `onActiveDescendantChange`.
					aria-activedescendant={
						unifiedPickerEnabled && unifiedOpen ? (unifiedActiveDescendant ?? undefined) : undefined
					}
					aria-controls={mentionTrigger !== null ? 'mention-picker-listbox' : undefined}
					aria-expanded={mentionTrigger !== null || undefined}
				/>
				{sendError || externalError ? (
					<p role="alert" className="px-1 text-error text-xs" aria-live="polite">
						{sendError ?? externalError} — your message is preserved; try again.
					</p>
				) : null}
				<div className="flex items-center gap-2">
					<DropdownMenu>
						<DropdownMenuTrigger asChild>
							{/* No 44 px `::before` here: Attach next to it already carries one,
							    and two overlapping invisible hit surfaces 8 px apart steal
							    taps from each other. The v2 control row is 28 px by design. */}
							<Button
								type="button"
								size="icon"
								variant="outline"
								className="h-7 w-7 shrink-0 rounded-full text-muted-foreground"
								disabled={disabled}
								aria-label="Add an object, file, or mention"
							>
								<Plus size={15} aria-hidden />
							</Button>
						</DropdownMenuTrigger>
						<DropdownMenuContent align="start" className="w-[252px]">
							{plusMenuAttachOnly ? (
								// Flag-on shape (task 6321aecf, bet f21a): the Reference /
								// Mention aliases founders reported broken are removed, and
								// Create-new moves to the `/` picker (sibling task). The
								// row triggers the same hidden fileInputRef as the visible
								// Paperclip sibling, so the file-attach handler that is
								// already wired for this composer is what runs.
								<DropdownMenuItem
									onSelect={() => fileInputRef.current?.click()}
									className="flex-col items-start gap-0.5"
								>
									<span className="flex items-center gap-2">
										<Paperclip size={15} aria-hidden />
										Attach a file
									</span>
									<span className="pl-[23px] text-xs text-muted-foreground">
										PDF, image, or doc
									</span>
								</DropdownMenuItem>
							) : (
								<>
									<DropdownMenuItem onSelect={() => openPickerForKind('item')}>
										<Box size={15} aria-hidden />
										Reference an object
									</DropdownMenuItem>
									<DropdownMenuItem onSelect={() => openPickerForKind('agent')}>
										<AtSign size={15} aria-hidden />
										Mention an agent
									</DropdownMenuItem>
									<DropdownMenuItem onSelect={() => openCreateFor(undefined)}>
										<Sparkles size={15} aria-hidden />
										Create an object
									</DropdownMenuItem>
								</>
							)}
						</DropdownMenuContent>
					</DropdownMenu>
					{/* Attach stays a visible sibling rather than a menu row: it is the
					    one composer affordance with a pinned 44 px touch target
					    (`ios-chat-attach-tap-area.spec.ts`), which a closed menu can't
					    satisfy. */}
					<Button
						type="button"
						size="icon"
						variant="ghost"
						className="relative h-7 w-7 shrink-0 rounded-full text-muted-foreground before:absolute before:-inset-2 before:h-11 before:w-11 before:content-['']"
						onClick={() => fileInputRef.current?.click()}
						disabled={disabled}
						aria-label="Attach file"
					>
						<Paperclip size={14} aria-hidden />
					</Button>
					{dictation.supported ? (
						<Button
							type="button"
							size="icon"
							variant={dictation.recording ? 'destructive' : 'outline'}
							className={cn(
								'ml-auto h-7 w-7 shrink-0 rounded-full',
								dictation.recording ? 'animate-pulse' : 'text-muted-foreground',
							)}
							onClick={dictation.toggle}
							disabled={disabled}
							aria-pressed={dictation.recording}
							aria-label={dictation.recording ? 'Stop dictating' : 'Dictate a message'}
						>
							<Mic size={14} aria-hidden />
						</Button>
					) : null}
					<Button
						type="submit"
						size="icon"
						className={cn(
							'h-7 w-7 shrink-0 rounded-full',
							dictation.supported ? '' : 'ml-auto',
							canSend
								? 'bg-primary text-primary-foreground'
								: 'bg-muted text-muted-foreground hover:bg-muted',
						)}
						disabled={!canSend}
						aria-label="Send message"
					>
						{/* An up-arrow, not a paper plane — v2's send glyph across every
						    composer (mockup 543). */}
						{showSpinner ? <Spinner /> : <ArrowUp size={15} />}
					</Button>
				</div>
			</form>
			{/* "Turn this into an object" — reuses the shipped creation flow rather
			    than the mockup's bespoke FROM-THIS-CHAT modal (800–848). The picked
			    type is seeded; the conversation itself is not, because pre-filling
			    the name / field table / "CONTEXT IT INHERITS" block needs a `seed`
			    prop on CreatePicker, which is owned elsewhere. */}
			<CreatePicker
				open={createOpen}
				onOpenChange={setCreateOpen}
				defaultType="object"
				defaultObjectSubtype={createSubtype}
				defaultText={createSeedTitle || undefined}
			/>
		</div>
	)
}
