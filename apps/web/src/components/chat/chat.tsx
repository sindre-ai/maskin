import { AgentCallButton } from '@/components/agents/agent-call-button'
import type { VoiceCallAgent } from '@/components/agents/voice-call-dialog'
import {
	MentionPicker,
	type MentionPickerActor,
	buildMentionSections,
	detectMentionTrigger,
	reduceMentionPickerKey,
} from '@/components/chat/mention-picker'
import { SecretCaptureFlow } from '@/components/chat/secret-capture-flow'
import { SelectionChips } from '@/components/chat/selection-chips'
import {
	UnifiedChatSlashPicker,
	type UnifiedChatSlashPickerHandle,
} from '@/components/chat/unified-slash-picker'
import { VaultPrefixFlow, vaultSeedFrom } from '@/components/chat/vault-prefix-flow'
import { CreatePicker } from '@/components/shared/create-picker'
import { UploadProgress } from '@/components/shared/upload-progress'
import { ViewerTooltip } from '@/components/shared/viewer-tooltip'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { Textarea } from '@/components/ui/textarea'
import { useActors } from '@/hooks/use-actors'
import { useCanWrite } from '@/hooks/use-can-write'
import { useConversationsInfinite } from '@/hooks/use-conversations'
import { useDictation } from '@/hooks/use-dictation'
import { useUploadFile } from '@/hooks/use-files'
import { useIsMobile } from '@/hooks/use-mobile'
import { trackChatMentionInserted, trackChatObjectReferenceCreated } from '@/lib/analytics'
import { getStoredActor } from '@/lib/auth'
import type { ChatSelection, ChatSelectionAction, ChatSelectionFile } from '@/lib/chat-selection'
import { cn } from '@/lib/cn'
import { toUploadInput } from '@/lib/large-file-upload'
import { splitLongMessage } from '@/lib/long-message'
import { hasHighConfidenceSecret, scanComposerText } from '@/lib/secret-scanner'
import { VIEWER_READ_ONLY_MESSAGE, isViewerRefusal } from '@/lib/workspace-role'
import { type SecretMatch, withoutSecrets } from '@maskin/shared'
import { ArrowUp, Hash, Info, Mic, Paperclip, X } from 'lucide-react'
import {
	type ChangeEvent,
	type ClipboardEvent,
	type FormEvent,
	type KeyboardEvent,
	useCallback,
	useEffect,
	useId,
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

// A screenshot reaches the clipboard with no real name (Chrome calls it "image.png").
// Give it a readable one; a copied file that already has a name keeps it.
const CLIPBOARD_IMAGE_EXTENSIONS: Record<string, string> = { jpeg: 'jpg', 'svg+xml': 'svg' }

export function nameClipboardImage(file: File, now: Date): File {
	if (!file.type.startsWith('image/')) return file
	if (file.name !== '' && !/^image\.[a-z0-9]+$/i.test(file.name)) return file
	const subtype = file.type.slice('image/'.length)
	const base = subtype.replace(/[^a-z0-9].*$/i, '') || 'png'
	const ext = CLIPBOARD_IMAGE_EXTENSIONS[subtype] ?? base
	const pad = (n: number) => String(n).padStart(2, '0')
	const stamp =
		`${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
		`-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
	return new File([file], `pasted-image-${stamp}.${ext}`, {
		type: file.type,
		lastModified: file.lastModified,
	})
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
 * inside the textarea. Returns one
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
	/**
	 * `extras.files` carries attachments the composer made itself (the full text of a message
	 * over the cap, see `longTextAsFile`). A caller that sets `longTextAsFile` must send them.
	 */
	onSend: (content: string, extras?: { files: ChatSelectionFile[] }) => Promise<void>
	disabled: boolean
	/**
	 * Text over the chat message cap is sent as a .txt attachment with a short body instead of
	 * being rejected. Only for callers that put `extras.files` on the message.
	 */
	longTextAsFile?: boolean
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
	 * One quiet line under the box, for the group-chat cue ("No agent will reply. Tag one
	 * with @."). Pass a string, or null when the cue applies but has nothing to say, to
	 * render the polite live region; leave it undefined for no region at all. The line
	 * shows once the box has focus, text or a tag, and never next to an error line.
	 */
	hint?: string | null
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
	/**
	 * Opt-in draft persistence key. When set (and the composer is uncontrolled),
	 * the draft is mirrored to `sessionStorage` under `composer-draft:<key>` and
	 * restored on mount. iOS reloads the tab when the user switches apps and
	 * comes back, which otherwise discards unsent text; `sessionStorage`
	 * survives that, and dies with the tab so an unsent prompt never outlives it.
	 */
	draftKey?: string
	/**
	 * Where a pasted provider secret can be vaulted: the live session of this
	 * conversation and the agent running it. Omit on a composer with no session; the
	 * guard still blocks the send and the card offers Cancel only.
	 */
	secretCapture?: {
		sessionId: string
		/** Lets the vault card watch the relaunched session come up. */
		conversationId?: string
		agent: { id: string; name: string }
	} | null
	/** The agent is restarting after a vault, so vaulting another secret waits for it. */
	secretRestarting?: boolean
	/**
	 * Vault mode (the ! prefix) opens but cannot vault: the conversation has no running
	 * session, or one that is still coming up.
	 */
	vaultModeBlocked?: boolean
	/** When set, a Call button for this agent sits beside the mic. Callers pass it
	 *  only when exactly one agent is addressed (a multi-agent call is v2). */
	callAgent?: VoiceCallAgent | null
	/**
	 * Asks the composer to replace its draft with `text` (when given), then focus
	 * with the caret at the end. Without `text` it only focuses and leaves the draft
	 * alone. One request per nonce: a request that was already there when the
	 * composer mounted never fires, so a stale one cannot overwrite a draft.
	 */
	fillRequest?: { text?: string; nonce: number } | null
}

const DRAFT_PREFIX = 'composer-draft:'

function readDraft(key: string): string {
	try {
		return sessionStorage.getItem(`${DRAFT_PREFIX}${key}`) ?? ''
	} catch {
		return ''
	}
}

function writeDraft(key: string, value: string): void {
	try {
		if (value) sessionStorage.setItem(`${DRAFT_PREFIX}${key}`, value)
		else sessionStorage.removeItem(`${DRAFT_PREFIX}${key}`)
	} catch {
		// Safari private mode throws on write; losing the draft is preferable to
		// breaking typing.
	}
}

/**
 * Chat composer. Enter sends, Shift+Enter inserts a newline, IME
 * composition swallows Enter. The textarea auto-resizes up to `max-h-40` and
 * scrolls beyond that. The send button shows a Spinner (and stays disabled)
 * while a turn is pending — i.e. after a send, until the caller flips
 * `pending` back to false.
 *
 * Entry points into pickers:
 *  - `/` typed at a word boundary opens the unified Reference / Create picker.
 *  - `@` typed at a word boundary opens the mention picker (agents + humans)
 *    inline at the caret; ↑↓ navigate, ↵ inserts, Escape closes. Textarea
 *    keeps DOM focus while the picker is open.
 *  - The paperclip attaches a file; `/` and `@` cover the rest.
 */
export function Composer({
	workspaceId,
	onSend,
	longTextAsFile,
	disabled: disabledByCaller,
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
	hint,
	conversationParticipantIds,
	textareaLabel,
	value: controlledValue,
	onValueChange,
	draftKey,
	secretCapture,
	secretRestarting,
	vaultModeBlocked,
	callAgent,
	fillRequest,
}: ComposerProps) {
	// Every send from a composer is a write, so a viewer gets the box switched off.
	const canWrite = useCanWrite()
	const disabled = disabledByCaller || !canWrite
	const [internalValue, setInternalValue] = useState(() =>
		controlledValue === undefined && draftKey ? readDraft(draftKey) : '',
	)
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
	const [secretFlow, setSecretFlow] = useState<{
		content: string
		matches: SecretMatch[]
		/** True until the user decides. False keeps only the receipts on screen. */
		blocking: boolean
	} | null>(null)
	const mutedPatternIds = useRef(new Set<string>())
	// Vault mode (the ! prefix) is part of the same feature, under the same flag. The
	// secret never enters this component: a pasted one waits in the seed ref until the
	// flow takes it, and what is typed afterwards lives in the flow's own field.
	const [vaultFlow, setVaultFlow] = useState<{ blocking: boolean; key: number } | null>(null)
	const vaultSeedRef = useRef('')
	const enterVault = useCallback((seed: string) => {
		vaultSeedRef.current = seed
		setVaultFlow((prev) => ({ blocking: true, key: (prev?.key ?? 0) + 1 }))
	}, [])
	// Mirror the draft into sessionStorage. The chat route swaps `draftKey`
	// without remounting the composer, so on a key change load the incoming
	// key's stored draft instead of writing the outgoing text under it.
	const draftKeyRef = useRef(draftKey)
	useEffect(() => {
		if (draftKey === undefined || controlledValue !== undefined) return
		if (draftKeyRef.current !== draftKey) {
			draftKeyRef.current = draftKey
			setValue(readDraft(draftKey))
			return
		}
		// Draft autosave is off while vault mode is open.
		if (vaultFlow?.blocking) return
		// A pasted secret must never reach sessionStorage: not while the card is open,
		// and not in the keystrokes before Send either.
		if (secretFlow?.blocking || hasHighConfidenceSecret(value, workspaceId)) {
			writeDraft(draftKey, '')
			return
		}
		writeDraft(draftKey, value)
	}, [
		draftKey,
		value,
		controlledValue,
		setValue,
		secretFlow?.blocking,
		vaultFlow?.blocking,
		workspaceId,
	])
	// Mobile soft keyboards have no Shift key, so the desktop `Shift+Enter`
	// newline shortcut is unreachable on a phone — plain Enter sends instead.
	// On touch viewports we let the browser insert a newline and rely on the
	// visible send button as the send affordance.
	const isMobile = useIsMobile()
	const [sending, setSending] = useState(false)
	const [sendError, setSendError] = useState<string | null>(null)
	const hintId = useId()
	const [textareaFocused, setTextareaFocused] = useState(false)
	const hintText =
		hint &&
		!(sendError || externalError) &&
		(textareaFocused || value.trim().length > 0 || selection.agents.length > 0)
			? hint
			: null
	// Unified `/` picker state. `slashStart`
	// points at the `/` in the textarea; when set, everything after it up to the
	// caret is the picker's live query. `typeFilterChip` is the NEWKIND label
	// (e.g. 'task') the user promoted by typing `/task ` — it lives outside the
	// text as a first-class composer chip and narrows both picker sections.
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
	// Position of the `@` that opened the mention picker and the query text
	// after it. Both null when the picker isn't in `@`-typing mode.
	const [mentionTrigger, setMentionTrigger] = useState<{ atPos: number; query: string } | null>(
		null,
	)
	const [mentionHighlightIndex, setMentionHighlightIndex] = useState(0)
	const fileInputRef = useRef<HTMLInputElement | null>(null)
	const textareaRef = useRef<HTMLTextAreaElement | null>(null)

	// A fill request replaces the draft through the same setter typing uses, so the
	// sessionStorage mirror keeps working, then puts the caret at the end. Seeded
	// with the nonce already present on mount so a stale request never fires.
	const handledFillNonceRef = useRef(fillRequest?.nonce)
	useEffect(() => {
		if (!fillRequest || fillRequest.nonce === handledFillNonceRef.current) return
		handledFillNonceRef.current = fillRequest.nonce
		if (fillRequest.text !== undefined) setValue(fillRequest.text)
		requestAnimationFrame(() => {
			const el = textareaRef.current
			if (!el) return
			el.focus()
			const end = el.value.length
			el.setSelectionRange(end, end)
		})
	}, [fillRequest, setValue])
	// `/` opens the create list (mockup 761–771). The chosen type seeds the
	// shipped create surface; the mockup's FROM-THIS-CHAT panel additionally
	// pre-fills the name/fields from the conversation, which needs a `seed`
	// prop on <CreatePicker> that doesn't exist yet — see the composer note
	// where it is rendered.
	const [createOpen, setCreateOpen] = useState(false)
	const [createSubtype, setCreateSubtype] = useState<string | undefined>(undefined)
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
	const mentionFlatRows = useMemo(() => mentionSections.flatMap((s) => s.rows), [mentionSections])
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
		workspaceId,
		// The clean pass only replaces the streamed text while it is untouched.
		useCallback(
			(streamed: string, refined: string) => {
				setValue((prev) => (prev.includes(streamed) ? prev.replace(streamed, () => refined) : prev))
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

	// Text over the cap is uploaded whole as a .txt file and the message carries a short body.
	// An upload that fails rejects, so the caller's catch keeps the draft in the box.
	const sendContent = useCallback(
		async (content: string) => {
			const split = longTextAsFile ? splitLongMessage(content) : null
			if (!split) {
				await onSend(content)
				return
			}
			const created = await uploadFile({
				name: split.file.name,
				mime_type: 'text/plain',
				content: split.file.content,
				encoding: 'utf8',
			})
			await onSend(split.body, {
				files: [
					{
						fileId: created.id,
						name: split.file.name,
						sizeBytes: new TextEncoder().encode(split.file.content).length,
						mimeType: 'text/plain',
					},
				],
			})
		},
		[longTextAsFile, onSend, uploadFile],
	)

	const handleSubmit = useCallback(
		async (e?: FormEvent<HTMLFormElement>) => {
			e?.preventDefault()
			if (!canSend) return
			const content = value.trim()
			const matches = scanComposerText(content, {
				workspaceId,
				mutedPatternIds: mutedPatternIds.current,
			})
			if (matches.length > 0) {
				// Before any network call. The text leaves the draft and the input and
				// lives only in the card's state until the user decides.
				if (draftKey !== undefined) writeDraft(draftKey, '')
				setSecretFlow({ content, matches, blocking: true })
				setValue('')
				return
			}
			setSending(true)
			setSendError(null)
			onDismissExternalError?.()
			let sent = false
			try {
				await sendContent(content)
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
		[canSend, draftKey, onDismissExternalError, sendContent, setValue, value, workspaceId],
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
				const joined = `${before}${trimmedAfter}`
				// Only whitespace left: keep the box empty so the placeholder (the composer
				// cue's "Reply to …") stays visible behind the chips.
				const next = joined.trim() === '' ? '' : joined
				requestAnimationFrame(() => {
					// Land the caret past the leading space we inserted
					const caret = next === '' ? 0 : before.length + 1
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
			if (e.key === 'Backspace' && typeFilterChip !== null && value.length === 0) {
				e.preventDefault()
				setTypeFilterChip(null)
				return
			}
			// While the unified picker is open, ↑↓ move its active row and ↵
			// selects it — routed through the imperative handle because focus
			// stays on the textarea and the picker Portal isn't a DOM ancestor.
			if (unifiedOpen) {
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
			if (e.key === 'Escape' && unifiedOpen) {
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
			if (unifiedOpen) {
				e.preventDefault()
				unifiedPickerRef.current?.selectActive()
				return
			}
			// On touch viewports there is no Shift key, so Enter must insert a
			// newline rather than send. The visible send button is the send
			// affordance there.
			if (isMobile) return
			e.preventDefault()
			void handleSubmit()
		},
		[
			handleSubmit,
			isMobile,

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
			// The prefix as the first character of an empty composer opens vault mode and
			// is consumed: setValue never sees it, so neither does the draft mirror.
			if (!vaultFlow?.blocking && valueRef.current === '') {
				const seed = vaultSeedFrom(next)
				if (seed !== null) {
					enterVault(seed)
					return
				}
			}
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
				setUnifiedOpen(false)
				setSlashStart(null)
				return
			}
			setMentionTrigger(null)

			// The top-level `/` path routes to `<UnifiedChatSlashPicker>`
			// (Reference on top, Create-new below).
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
			// `outcome.type === 'noop'` — either not triggering, or already tracking the
			// same `/` and the user is just typing more chars.
		},
		[setValue, slashStart, typeFilterChip, vaultFlow?.blocking, enterVault],
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

	const uploadPickedFile = useCallback(
		async (tempId: string, file: File) => {
			const controller = new AbortController()
			abortControllersRef.current.set(tempId, controller)
			try {
				const created = await uploadFile(await toUploadInput(file), {
					signal: controller.signal,
					onProgress: (progress) => {
						setPendingUploads((prev) =>
							prev.map((p) => (p.tempId === tempId ? { ...p, progress } : p)),
						)
					},
				})
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
				const message = isViewerRefusal(err)
					? VIEWER_READ_ONLY_MESSAGE
					: err instanceof Error
						? err.message
						: 'Upload failed'
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

	// The one entry point for files into the composer: the picker and a clipboard
	// paste both end here, so a chip behaves the same whichever way it arrived.
	const attachFiles = useCallback(
		(files: File[]) => {
			if (!canWrite) return
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
		[uploadPickedFile, canWrite],
	)

	const handleFileSelection = useCallback(
		(event: ChangeEvent<HTMLInputElement>) => {
			const input = event.target
			const files = Array.from(input.files ?? [])
			input.value = '' // allow re-picking the same file after removing it
			attachFiles(files)
		},
		[attachFiles],
	)

	// A paste that starts with the prefix and has no whitespace, into an empty composer,
	// goes straight to the vault field. Intercepted before the textarea takes it, so the
	// secret is never in the composer's value, not even for a frame.
	// A paste that carries files and no text attaches them. Text always wins: copying
	// from a web page or spreadsheet puts a rendered image next to the text, and the
	// text is what the user meant to paste.
	const handlePaste = useCallback(
		(e: ClipboardEvent<HTMLTextAreaElement>) => {
			if (vaultFlow?.blocking) return
			const text = e.clipboardData.getData('text')
			if (valueRef.current === '') {
				const seed = vaultSeedFrom(text)
				if (seed !== null) {
					e.preventDefault()
					enterVault(seed)
					return
				}
			}
			if (text !== '') return
			const files = Array.from(e.clipboardData.files)
			if (files.length === 0) return
			e.preventDefault()
			const now = new Date()
			attachFiles(files.map((file) => nameClipboardImage(file, now)))
		},
		[vaultFlow?.blocking, enterVault, attachFiles],
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
				vaultFlow?.blocking && 'border-brand bg-brand-subtle ring-2 ring-brand/30',
			)}
		>
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
			{typeFilterChip !== null ? (
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
			{secretFlow ? (
				<SecretCaptureFlow
					workspaceId={workspaceId}
					content={secretFlow.content}
					matches={secretFlow.matches}
					capture={secretCapture ?? null}
					agentName={secretCapture?.agent.name ?? 'the agent'}
					restarting={secretRestarting}
					onSend={sendContent}
					onCancel={() => {
						// The message is dropped, not the person's words: the text comes back
						// without the secret, so cancelling never costs them what they wrote.
						const restored = withoutSecrets(secretFlow.content, secretFlow.matches)
						setSecretFlow(null)
						setValue(restored)
						textareaRef.current?.focus()
					}}
					onEdit={() => {
						const restored = secretFlow.content
						setSecretFlow(null)
						setValue(restored)
						textareaRef.current?.focus()
					}}
					onDone={(keepReceipts) =>
						setSecretFlow(keepReceipts ? (prev) => prev && { ...prev, blocking: false } : null)
					}
					onMute={(ids) => {
						for (const id of ids) mutedPatternIds.current.add(id)
					}}
				/>
			) : null}
			{vaultFlow ? (
				<VaultPrefixFlow
					key={vaultFlow.key}
					workspaceId={workspaceId}
					seedRef={vaultSeedRef}
					capture={secretCapture ?? null}
					unavailable={!secretCapture || vaultModeBlocked === true}
					agentName={secretCapture?.agent.name ?? 'the agent'}
					onSend={onSend}
					onLeave={() => {
						setVaultFlow(null)
						requestAnimationFrame(() => textareaRef.current?.focus())
					}}
					onDone={(keepReceipts) => {
						setVaultFlow(keepReceipts ? (prev) => prev && { ...prev, blocking: false } : null)
						requestAnimationFrame(() => textareaRef.current?.focus())
					}}
				/>
			) : null}
			{/* Hidden rather than unmounted while vault mode is open, so the composer's own
			    state is untouched when the user comes back to it. */}
			<ViewerTooltip className="block">
				<form onSubmit={handleSubmit} hidden={vaultFlow?.blocking === true}>
					<Textarea
						autoResize
						ref={textareaRef}
						value={value}
						onChange={handleChange}
						onPaste={handlePaste}
						onKeyDown={handleKeyDown}
						placeholder={canWrite ? placeholder : VIEWER_READ_ONLY_MESSAGE}
						className="max-h-40 min-h-[36px] w-full resize-none overflow-y-auto border-0 bg-transparent p-1 text-sm focus-visible:ring-0 focus-visible:ring-offset-0"
						disabled={disabled || secretFlow?.blocking === true || vaultFlow?.blocking === true}
						rows={1}
						aria-label={textareaLabel}
						aria-describedby={hint === undefined ? undefined : hintId}
						onFocus={() => setTextareaFocused(true)}
						onBlur={() => setTextareaFocused(false)}
						// Screen readers announce the picker's active row while focus
						// stays on the textarea (spec §Accessibility). The picker
						// keeps this in sync via `onActiveDescendantChange`.
						aria-activedescendant={unifiedOpen ? (unifiedActiveDescendant ?? undefined) : undefined}
						aria-controls={mentionTrigger !== null ? 'mention-picker-listbox' : undefined}
						aria-expanded={mentionTrigger !== null || undefined}
					/>
					{sendError || externalError ? (
						<p role="alert" className="px-1 text-error text-xs" aria-live="polite">
							{sendError ?? externalError} — your message is preserved; try again.
						</p>
					) : null}
					{hint === undefined ? null : (
						<output
							id={hintId}
							aria-live="polite"
							className={cn(
								'px-1 text-muted-foreground text-xs',
								// The icon and the 8 px gap above the control row exist only while there is text,
								// so the empty live region adds no height.
								hintText ? 'mb-2 flex items-start gap-1.5' : 'block',
							)}
						>
							{hintText ? <Info aria-hidden className="mt-px size-3.5 shrink-0" /> : null}
							{hintText}
						</output>
					)}
					<div className="flex items-center gap-2">
						{/* Attach carries a pinned 44 px touch target (`ios-chat-attach-tap-area.spec.ts`). */}
						<Button
							type="button"
							size="icon"
							variant="ghost"
							className="relative h-7 w-7 shrink-0 rounded-full text-muted-foreground before:absolute before:right-0 before:top-1/2 before:h-11 before:w-11 before:-translate-y-1/2 before:content-['']"
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
								disabled={disabled || dictation.transcribing}
								aria-pressed={dictation.recording}
								aria-busy={dictation.transcribing}
								aria-label={
									dictation.transcribing
										? 'Transcribing'
										: dictation.recording
											? 'Stop dictating'
											: 'Dictate a message'
								}
							>
								{dictation.transcribing ? <Spinner /> : <Mic size={14} aria-hidden />}
							</Button>
						) : null}
						{callAgent ? (
							// `ml-auto` here only when the mic didn't already claim the gap.
							<span className={cn('inline-flex', dictation.supported ? '' : 'ml-auto')}>
								<AgentCallButton agent={callAgent} variant="composer" shortcut={false} />
							</span>
						) : null}
						<Button
							type="submit"
							size="icon"
							className={cn(
								'h-7 w-7 shrink-0 rounded-full',
								dictation.supported || callAgent ? '' : 'ml-auto',
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
			</ViewerTooltip>
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
