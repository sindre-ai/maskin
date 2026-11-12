import { AgentCallButton } from '@/components/agents/agent-call-button'
import type { VoiceCallAgent } from '@/components/agents/voice-call-dialog'
import { ComposerFormatBar, useShowFormatting } from '@/components/chat/composer-format-bar'
import {
	MentionPicker,
	type MentionPickerActor,
	buildMentionSections,
	detectMentionTrigger,
	reduceMentionPickerKey,
} from '@/components/chat/mention-picker'
import {
	type ComposerFormat,
	type RichComposerHandle,
	RichComposerInput,
} from '@/components/chat/rich-composer-input'
import { SecretCaptureFlow } from '@/components/chat/secret-capture-flow'
import { SelectionChips } from '@/components/chat/selection-chips'
import { TagInput, type TagInputHandle } from '@/components/chat/tag-input'
import { VaultPrefixFlow, vaultSeedFrom } from '@/components/chat/vault-prefix-flow'
import { UploadProgress } from '@/components/shared/upload-progress'
import { ViewerTooltip } from '@/components/shared/viewer-tooltip'
import { Button } from '@/components/ui/button'
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Spinner } from '@/components/ui/spinner'
import { Textarea } from '@/components/ui/textarea'
import { useActors } from '@/hooks/use-actors'
import { useCanWrite } from '@/hooks/use-can-write'
import { useConversationsInfinite } from '@/hooks/use-conversations'
import { useDictation } from '@/hooks/use-dictation'
import { useUploadFile } from '@/hooks/use-files'
import { useIsMobile } from '@/hooks/use-mobile'
import { trackChatMentionInserted } from '@/lib/analytics'
import { getStoredActor } from '@/lib/auth'
import type { ChatSelection, ChatSelectionAction, ChatSelectionFile } from '@/lib/chat-selection'
import { cn } from '@/lib/cn'
import { toUploadInput } from '@/lib/large-file-upload'
import { splitLongMessage } from '@/lib/long-message'
import { hasHighConfidenceSecret, scanComposerText } from '@/lib/secret-scanner'
import { type TagValue, isTaggable, splitTextByTags, tagLabel } from '@/lib/tag-input-model'
import { VIEWER_READ_ONLY_MESSAGE, isViewerRefusal } from '@/lib/workspace-role'
import { type SecretMatch, withStarterPrompt, withoutSecrets } from '@maskin/shared'
import { ArrowUp, AtSign, FileText, Image, Info, Mic, Plus, Type, X } from 'lucide-react'
import {
	type ChangeEvent,
	type ClipboardEvent,
	type DragEvent,
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

/**
 * Whether the message has anything to send: words, or an uploaded attachment (the caller passes
 * 0 when attachment-only sends are off). Any upload still running or failed blocks the send.
 */
export function canSendMessage({
	text,
	attachmentCount,
	uploadsInFlight,
}: {
	text: string
	attachmentCount: number
	uploadsInFlight: number
}): boolean {
	return (text.trim().length > 0 || attachmentCount > 0) && uploadsInFlight === 0
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
	/**
	 * Send is on with no text when at least one attachment has finished uploading. Only for
	 * callers whose `onSend` puts `selection.files` on the message.
	 */
	allowAttachmentOnly?: boolean
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
	 * with the caret at the end. With `append` the text goes after the draft instead
	 * (a starter prompt never erases what was typed). Without `text` it only focuses
	 * and leaves the draft alone. One request per nonce: a request that was already there when the
	 * composer mounted never fires, so a stale one cannot overwrite a draft.
	 */
	fillRequest?: { text?: string; append?: boolean; nonce: number } | null
	/**
	 * Writes in the shared tag input instead of a textarea: an `@` tag stays in the sentence as
	 * a chip and the tagged ids reach the selection (`add_agent` / `remove_agent`) from the chips
	 * alone, so a typed `@name` that never went through the picker sends no id. The selection's
	 * agent pills are not drawn in this mode. Off by default; callers opt in one by one.
	 */
	inlineTags?: boolean
	/**
	 * Writes in the formatting box (bold, italic, lists, quotes, code, links) instead of plain
	 * text. Tags are chips in the sentence, as with `inlineTags`, which it switches on. The
	 * draft and the sent text are markdown. Off by default; the chat callers pass the flag.
	 */
	richText?: boolean
	/**
	 * Called when the up arrow is pressed in an empty box. The caller opens its latest message
	 * for editing. Without it the arrow keeps its normal job in the box.
	 */
	onEditLast?: () => void
}

const DRAFT_PREFIX = 'composer-draft:'

function readDraft(key: string): string {
	try {
		return sessionStorage.getItem(`${DRAFT_PREFIX}${key}`) ?? ''
	} catch {
		return ''
	}
}

// Chips in a draft: the text keeps "@Name", this keeps which id each chip stood for.
function readDraftTags(key: string): { id: string; label: string }[] {
	try {
		const raw = sessionStorage.getItem(`${DRAFT_PREFIX}${key}:tags`)
		const parsed: unknown = raw ? JSON.parse(raw) : []
		if (!Array.isArray(parsed)) return []
		return parsed.filter(
			(t): t is { id: string; label: string } =>
				!!t && typeof t.id === 'string' && typeof t.label === 'string',
		)
	} catch {
		return []
	}
}

function writeDraftTags(key: string, tags: { id: string; label: string }[]): void {
	try {
		if (tags.length > 0) sessionStorage.setItem(`${DRAFT_PREFIX}${key}:tags`, JSON.stringify(tags))
		else sessionStorage.removeItem(`${DRAFT_PREFIX}${key}:tags`)
	} catch {
		// Same as writeDraft: losing the draft beats breaking typing.
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
 * What the composer's one round action button is. It swaps between the mic (empty draft),
 * the send arrow (typed), the listening bars (dictating) and a spinner (transcribing).
 * Without dictation support an empty draft shows a disabled send arrow.
 */
export type ComposerActionMode = 'mic' | 'send' | 'listening' | 'transcribing'

export function composerActionMode({
	hasText,
	busy,
	dictationSupported,
	recording,
	transcribing,
}: {
	hasText: boolean
	/** A send is in flight, so the arrow (as a spinner) stays put. */
	busy: boolean
	dictationSupported: boolean
	recording: boolean
	transcribing: boolean
}): ComposerActionMode {
	if (recording) return 'listening'
	if (transcribing) return 'transcribing'
	if (hasText || busy || !dictationSupported) return 'send'
	return 'mic'
}

/**
 * Chat composer. Enter sends, Shift+Enter inserts a newline, IME
 * composition swallows Enter. The textarea auto-resizes up to `max-h-40` and
 * scrolls beyond that. The send button shows a Spinner (and stays disabled)
 * while a turn is pending — i.e. after a send, until the caller flips
 * `pending` back to false.
 *
 * Entry points into pickers:
 *  - `@` typed at a word boundary opens the mention picker (agents + humans)
 *    inline at the caret; ↑↓ navigate, ↵ inserts, Escape closes. Textarea
 *    keeps DOM focus while the picker is open.
 *  - The + menu attaches a photo or file, or starts an `@` mention.
 */
export function Composer({
	workspaceId,
	onSend,
	longTextAsFile,
	allowAttachmentOnly,
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
	inlineTags: inlineTagsProp = false,
	richText = false,
	onEditLast,
}: ComposerProps) {
	const inlineTags = inlineTagsProp || richText
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
	// Pool for the mention picker — cached workspace actors. `useActors` uses
	// the same query key as every other surface in the app so the picker opens
	// against warm data (spec: `list_actors({ workspace_id, limit: 100 })` on
	// chat mount, cached for the session).
	const { data: workspaceActors } = useActors(workspaceId, { enabled: true })
	const mentionActors = useMemo<MentionPickerActor[]>(
		() =>
			(workspaceActors ?? [])
				// Filters out Google Calendar / Gmail / Slack / GitHub / Ubersuggest (type "system").
				.filter(isTaggable)
				.map((a) => ({
					id: a.id,
					name: a.name,
					type: a.type,
					description: a.description,
					email: a.email,
				})),
		[workspaceActors],
	)
	// Inline tags. `tagIds` are the ids the chips in the input stand for, in order (`tagIdsRef` is
	// the same list for handlers). `tagLabelsRef` keeps the names a restored draft carried until
	// the actor list has loaded. `domTextRef` is the text the input shows right now: when `value`
	// moves away from it (a fill, dictation, a restored draft, a send that cleared the box) the
	// input is rebuilt from `value`.
	const [restoredTags] = useState(() =>
		inlineTags && controlledValue === undefined && draftKey ? readDraftTags(draftKey) : [],
	)
	const tagLabelsRef = useRef(new Map(restoredTags.map((t) => [t.id, t.label])))
	const [initialTagContent] = useState(() => {
		const ids = restoredTags.map((t) => t.id)
		const { segments, unmatchedIds } = splitTextByTags(
			value,
			ids,
			(id) => tagLabelsRef.current.get(id) ?? null,
		)
		return { segments, ids: ids.filter((id) => !unmatchedIds.includes(id)) }
	})
	const [tagIds, setTagIds] = useState<string[]>(initialTagContent.ids)
	const tagIdsRef = useRef(tagIds)
	const domTextRef = useRef(value)
	const tagRef = useRef<TagInputHandle | null>(null)
	const richRef = useRef<RichComposerHandle | null>(null)
	const [activeFormats, setActiveFormats] = useState<ComposerFormat[]>([])
	const tagWrapRef = useRef<HTMLDivElement | null>(null)
	const tagsKeyRef = useRef(draftKey)

	const tagLabelOf = useCallback(
		(id: string): string | null => {
			const actor = mentionActors.find((a) => a.id === id)
			if (actor) return tagLabel(actor, mentionActors)
			return tagLabelsRef.current.get(id) ?? selection.agentNames[id] ?? null
		},
		[mentionActors, selection.agentNames],
	)

	// Keeps the selection's agent list equal to the chips in the input: the callers build
	// `metadata.mentions` from it, so only a picked tag ever sends an id.
	const syncTagIds = useCallback(
		(next: string[], fromTyping: boolean) => {
			const prev = tagIdsRef.current
			if (prev.length === next.length && prev.every((id, i) => id === next[i])) return
			tagIdsRef.current = next
			setTagIds(next)
			for (const id of prev) {
				if (!next.includes(id)) onDispatchSelection?.({ type: 'remove_agent', id })
			}
			for (const id of next) {
				if (prev.includes(id)) continue
				const actor = mentionActors.find((a) => a.id === id)
				onDispatchSelection?.({ type: 'add_agent', agent: { id, name: actor?.name } })
				if (fromTyping && actor) {
					trackChatMentionInserted({
						entity_id: actor.id,
						entity_type: 'actor',
						kind: actor.type === 'agent' ? 'agent' : 'human',
					})
				}
			}
		},
		[mentionActors, onDispatchSelection],
	)

	const restoreTags = useCallback(
		(tags: { id: string; label: string }[]) => {
			for (const t of tags) tagLabelsRef.current.set(t.id, t.label)
			syncTagIds(
				tags.map((t) => t.id),
				false,
			)
		},
		[syncTagIds],
	)

	// A draft that came back with chips: the selection starts empty, so hand it the ids once.
	// biome-ignore lint/correctness/useExhaustiveDependencies: runs once, for the draft read at mount.
	useEffect(() => {
		for (const id of initialTagContent.ids) {
			const actor = mentionActors.find((a) => a.id === id)
			onDispatchSelection?.({ type: 'add_agent', agent: { id, name: actor?.name } })
		}
	}, [])

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
			if (inlineTags) restoreTags(readDraftTags(draftKey))
			setValue(readDraft(draftKey))
			return
		}
		// Draft autosave is off while vault mode is open.
		if (vaultFlow?.blocking) return
		// A pasted secret must never reach sessionStorage: not while the card is open,
		// and not in the keystrokes before Send either.
		if (secretFlow?.blocking || hasHighConfidenceSecret(value, workspaceId)) {
			writeDraft(draftKey, '')
			if (inlineTags) writeDraftTags(draftKey, [])
			return
		}
		writeDraft(draftKey, value)
		// The chips ride along under the same key. The render that switched keys only restores.
		if (inlineTags) {
			if (tagsKeyRef.current !== draftKey) tagsKeyRef.current = draftKey
			else {
				writeDraftTags(
					draftKey,
					tagIds.flatMap((id) => {
						const label = tagLabelOf(id)
						return label ? [{ id, label }] : []
					}),
				)
			}
		}
	}, [
		draftKey,
		value,
		controlledValue,
		setValue,
		inlineTags,
		restoreTags,
		tagIds,
		tagLabelOf,
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
	const photoInputRef = useRef<HTMLInputElement | null>(null)
	const textareaRef = useRef<HTMLTextAreaElement | null>(null)
	const focusInput = useCallback(() => {
		if (richText) richRef.current?.focus()
		else if (inlineTags) tagRef.current?.focus()
		else textareaRef.current?.focus()
	}, [inlineTags, richText])

	// A fill request replaces the draft through the same setter typing uses, so the
	// sessionStorage mirror keeps working, then puts the caret at the end. Seeded
	// with the nonce already present on mount so a stale request never fires.
	const handledFillNonceRef = useRef(fillRequest?.nonce)
	useEffect(() => {
		if (!fillRequest || fillRequest.nonce === handledFillNonceRef.current) return
		handledFillNonceRef.current = fillRequest.nonce
		if (fillRequest.text !== undefined) {
			const text = fillRequest.text
			if (fillRequest.append) setValue((prev) => withStarterPrompt(prev, text))
			else setValue(text)
		}
		requestAnimationFrame(() => {
			if (richText) return richRef.current?.focus()
			if (inlineTags) return tagRef.current?.focus()
			const el = textareaRef.current
			if (!el) return
			el.focus()
			const end = el.value.length
			el.setSelectionRange(end, end)
		})
	}, [fillRequest, setValue, inlineTags, richText])
	const abortControllersRef = useRef<Map<string, AbortController>>(new Map())
	const uploadFile = useUploadFile(workspaceId)
	const selfActor = getStoredActor()
	const selfActorId = selfActor?.id ?? null
	// The format row above the box is the person's own choice, kept per person on this device.
	const [showFormatting, setShowFormatting] = useShowFormatting(selfActorId)

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

	// The chips the formatting box shows, from the ids the selection holds.
	const richTags = useCallback(
		() =>
			tagIdsRef.current.flatMap((id) => {
				const label = tagLabelOf(id)
				return label ? [{ id, label }] : []
			}),
		[tagLabelOf],
	)
	// The input follows `value` whenever something other than typing changed it.
	const tagSegmentsFor = useCallback(
		(text: string) => splitTextByTags(text, tagIdsRef.current, tagLabelOf).segments,
		[tagLabelOf],
	)
	// biome-ignore lint/correctness/useExhaustiveDependencies: `value` is the trigger; the check reads the refs so a render that lags behind typing cannot overwrite it.
	useEffect(() => {
		if (!inlineTags || valueRef.current === domTextRef.current) return
		const hadFocus = tagWrapRef.current?.contains(document.activeElement) ?? false
		if (richText) richRef.current?.setMarkdown(valueRef.current, richTags())
		else tagRef.current?.setContent(tagSegmentsFor(valueRef.current))
		if (hadFocus) focusInput()
	}, [inlineTags, richText, value, tagSegmentsFor, richTags, focusInput])

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
		canSendMessage({
			text: value,
			attachmentCount: allowAttachmentOnly ? selection.files.length : 0,
			uploadsInFlight: pendingUploads.length,
		}) &&
		!disabled &&
		!sending &&
		!pending
	const showSpinner = sending || pending
	const actionMode = composerActionMode({
		hasText: value.trim().length > 0,
		busy: sending || pending,
		dictationSupported: dictation.supported,
		recording: dictation.recording,
		transcribing: dictation.transcribing,
	})
	// Say why Send is off when an upload is the only thing in the way (a failed
	// one has to be removed, a running one has to finish).
	const failedUploads = pendingUploads.filter((p) => p.status === 'failed').length
	const uploadBlockReason =
		failedUploads > 0
			? `Remove the failed upload${failedUploads === 1 ? '' : 's'} to send`
			: pendingUploads.length > 0
				? `Waiting for ${pendingUploads.length} upload${pendingUploads.length === 1 ? '' : 's'} to finish`
				: null

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
		(e: KeyboardEvent<HTMLTextAreaElement | HTMLDivElement>) => {
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
			if (
				e.key === 'ArrowUp' &&
				onEditLast &&
				valueRef.current === '' &&
				tagIdsRef.current.length === 0 &&
				!e.shiftKey &&
				!e.altKey &&
				!e.ctrlKey &&
				!e.metaKey &&
				!e.nativeEvent.isComposing
			) {
				e.preventDefault()
				onEditLast()
				return
			}
			if (e.key !== 'Enter') return
			if (e.shiftKey) return
			if (e.nativeEvent.isComposing) return
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
			mentionTrigger,
			mentionFlatRows,
			mentionHighlightIndex,
			commitMention,
			onEditLast,
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
			// after the `@` — the query updates, the picker filters.
			const mention = detectMentionTrigger(next, pos)
			if (mention) {
				setMentionTrigger(mention)
				return
			}
			setMentionTrigger(null)
		},
		[setValue, vaultFlow?.blocking, enterVault],
	)

	// The tag input reports text and chip ids on every change. The `!` vault prefix
	// and the id list work off that, the same as handleChange does for the textarea.
	const handleTagChange = useCallback(
		(next: TagValue) => {
			domTextRef.current = next.text
			if (!vaultFlow?.blocking && valueRef.current === '') {
				const seed = vaultSeedFrom(next.text)
				if (seed !== null) {
					enterVault(seed)
					if (richText) richRef.current?.setMarkdown('', [])
					else tagRef.current?.setContent([])
					return
				}
			}
			setValue(next.text)
			syncTagIds(next.ids, true)
		},
		[vaultFlow?.blocking, enterVault, setValue, syncTagIds, richText],
	)

	// The formatting box asks about every key first, with the browser's own event. A key the
	// picker or the send rule used is marked as handled by preventDefault, which is what comes back.
	const handleRichKeyDown = useCallback(
		(e: globalThis.KeyboardEvent) => {
			handleKeyDown({
				key: e.key,
				shiftKey: e.shiftKey,
				altKey: e.altKey,
				ctrlKey: e.ctrlKey,
				metaKey: e.metaKey,
				nativeEvent: e,
				preventDefault: () => e.preventDefault(),
			} as unknown as KeyboardEvent<HTMLDivElement>)
			return e.defaultPrevented
		},
		[handleKeyDown],
	)
	// Picks a row of the picker: the chip replaces the "@query" in the sentence.
	const commitRichMention = useCallback(
		(actor: MentionPickerActor) => {
			richRef.current?.insertMention({ id: actor.id, label: tagLabel(actor, mentionActors) })
			setMentionTrigger(null)
		},
		[mentionActors],
	)

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

	// Dropping files on the composer attaches them through the same path as the picker and a
	// paste. Only a drag that carries files counts; dragging text or a link is left alone.
	const [dropTargeted, setDropTargeted] = useState(false)
	const dragCarriesFiles = (e: DragEvent<HTMLElement>) => e.dataTransfer.types.includes('Files')
	const handleDragOver = (e: DragEvent<HTMLElement>) => {
		if (!canWrite || !dragCarriesFiles(e)) return
		e.preventDefault()
		e.dataTransfer.dropEffect = 'copy'
		setDropTargeted(true)
	}
	const handleDragLeave = (e: DragEvent<HTMLElement>) => {
		// Moving over a child fires dragleave on the composer; only clear when truly leaving.
		if (e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget)) return
		setDropTargeted(false)
	}
	const handleDrop = (e: DragEvent<HTMLElement>) => {
		setDropTargeted(false)
		if (!canWrite || !dragCarriesFiles(e)) return
		e.preventDefault()
		attachFiles(Array.from(e.dataTransfer.files))
	}

	// A paste that starts with the prefix and has no whitespace, into an empty composer,
	// goes straight to the vault field. Intercepted before the textarea takes it, so the
	// secret is never in the composer's value, not even for a frame.
	// A paste that carries files and no text attaches them. Text always wins: copying
	// from a web page or spreadsheet puts a rendered image next to the text, and the
	// text is what the user meant to paste.
	const handlePaste = useCallback(
		(e: ClipboardEvent<HTMLElement>) => {
			if (vaultFlow?.blocking) return
			const text = e.clipboardData.getData('text')
			if (valueRef.current === '') {
				const seed = vaultSeedFrom(text)
				if (seed !== null) {
					e.preventDefault()
					// The tag input listens for paste too; the secret must not reach it.
					e.stopPropagation()
					enterVault(seed)
					return
				}
			}
			if (text !== '') return
			const files = Array.from(e.clipboardData.files)
			if (files.length === 0) return
			e.preventDefault()
			e.stopPropagation()
			const now = new Date()
			attachFiles(files.map((file) => nameClipboardImage(file, now)))
		},
		[vaultFlow?.blocking, enterVault, attachFiles],
	)

	// The + menu's Person-or-agent row types the `@` for the person and opens the same picker
	// typing it would, so there is one path to the picker.
	const startMention = useCallback(() => {
		if (richText) {
			richRef.current?.startMention()
			return
		}
		const current = valueRef.current
		const base = current === '' || /\s$/.test(current) ? current : `${current} `
		setValue(`${base}@`)
		setMentionTrigger({ atPos: base.length, query: '' })
		requestAnimationFrame(() => textareaRef.current?.focus())
	}, [setValue, richText])

	const handleRemovePending = useCallback((tempId: string) => {
		// Abort first so the in-flight XHR is cancelled before the request can
		// finish on the server. uploadPickedFile's catch branch sees
		// signal.aborted=true and skips the error toast; the file row never
		// gets created in the backend (AC-T4).
		abortControllersRef.current.get(tempId)?.abort()
		abortControllersRef.current.delete(tempId)
		setPendingUploads((prev) => prev.filter((p) => p.tempId !== tempId))
	}, [])

	// The chips in the sentence are the tags, so the pill row shows only the agents that have no chip
	// (a thread reply's seeded recipient), which stay visible and removable.
	const chipSelection = useMemo(
		() =>
			inlineTags
				? { ...selection, agents: selection.agents.filter((id) => !tagIds.includes(id)) }
				: selection,
		[inlineTags, selection, tagIds],
	)

	return (
		<div
			className={cn(
				'relative mx-auto flex w-full max-w-[860px] flex-col gap-2',
				// The secret and vault cards keep a box of their own; the bar is the box otherwise.
				(secretFlow || vaultFlow) &&
					'rounded-2xl border border-input bg-card px-3 py-2.5 shadow-sm',
				vaultFlow?.blocking && 'border-brand bg-brand-subtle ring-2 ring-brand/30',
			)}
		>
			{/* Inline `@` mention picker — the composer's textarea remains the
			    focused element, and the picker consumes arrow keys / Enter /
			    Escape via `handleKeyDown`'s `reduceMentionPickerKey` branch. */}
			{/* In inline-tag mode the tag input owns the `@` picker. The formatting box has none of
			    its own, so this one serves it and puts a chip in the sentence. */}
			{inlineTags && !richText ? null : (
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
					onSelect={(actor) => (richText ? commitRichMention(actor) : commitMention(actor))}
					highlightIndex={richText ? mentionHighlightIndex : undefined}
					onHighlightChange={richText ? setMentionHighlightIndex : undefined}
					anchor={
						richText ? (
							<span aria-hidden className="pointer-events-none absolute inset-0" />
						) : (
							<span aria-hidden className="pointer-events-none absolute left-2 bottom-2 h-0 w-0" />
						)
					}
				/>
			)}
			<SelectionChips
				selection={chipSelection}
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
			{uploadBlockReason && (
				<output className="block px-1 text-xs text-muted-foreground">{uploadBlockReason}</output>
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
			<input
				ref={photoInputRef}
				type="file"
				accept="image/*"
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
						focusInput()
					}}
					onEdit={() => {
						const restored = secretFlow.content
						setSecretFlow(null)
						setValue(restored)
						focusInput()
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
						requestAnimationFrame(focusInput)
					}}
					onDone={(keepReceipts) => {
						setVaultFlow(keepReceipts ? (prev) => prev && { ...prev, blocking: false } : null)
						requestAnimationFrame(focusInput)
					}}
				/>
			) : null}
			{/* Hidden rather than unmounted while vault mode is open, so the composer's own
			    state is untouched when the user comes back to it. */}
			<ViewerTooltip className="block">
				<form onSubmit={handleSubmit} hidden={vaultFlow?.blocking === true}>
					{richText && showFormatting ? (
						<ComposerFormatBar
							active={activeFormats}
							disabled={disabled || secretFlow?.blocking === true}
							onToggle={(format) => richRef.current?.toggleFormat(format)}
							onSetLink={(href) => richRef.current?.setLink(href)}
							onRemoveLink={() => richRef.current?.removeLink()}
							linkHref={() => richRef.current?.linkHref() ?? null}
							focusBox={focusInput}
						/>
					) : null}
					<div
						onDragOver={handleDragOver}
						onDragLeave={handleDragLeave}
						onDrop={handleDrop}
						className={cn(
							// shadow-md: the bar floats over the page, so it lifts off the content behind it.
							'flex items-end gap-1.5 rounded-3xl bg-card p-1.5 shadow-md inset-ring inset-ring-input max-md:p-1',
							dropTargeted && 'outline-2 outline-dashed outline-ring',
						)}
					>
						{/* + opens the attach menu. It keeps a 44 px target on touch widths. */}
						<DropdownMenu>
							<DropdownMenuTrigger asChild>
								<Button
									type="button"
									size="icon"
									variant="ghost"
									className="shrink-0 rounded-full text-muted-foreground max-md:size-11"
									disabled={disabled}
									aria-label="Attach file"
								>
									<Plus size={20} aria-hidden />
								</Button>
							</DropdownMenuTrigger>
							<DropdownMenuContent
								align="start"
								side="top"
								onCloseAutoFocus={(e) => {
									e.preventDefault()
									focusInput()
								}}
							>
								<DropdownMenuItem onSelect={() => photoInputRef.current?.click()}>
									<Image aria-hidden /> Photo
								</DropdownMenuItem>
								<DropdownMenuItem onSelect={() => fileInputRef.current?.click()}>
									<FileText aria-hidden /> File
								</DropdownMenuItem>
								<DropdownMenuItem onSelect={startMention}>
									<AtSign aria-hidden /> Person or agent
								</DropdownMenuItem>
								{richText ? (
									<DropdownMenuItem onSelect={() => setShowFormatting(!showFormatting)}>
										<Type aria-hidden /> {showFormatting ? 'Hide formatting' : 'Show formatting'}
									</DropdownMenuItem>
								) : null}
							</DropdownMenuContent>
						</DropdownMenu>
						{richText ? (
							// Paste is caught on the wrapper first: a secret or a file must not reach the editor.
							<div
								ref={tagWrapRef}
								className="min-w-0 flex-1 px-1 py-1.5 max-md:py-2"
								onFocus={() => setTextareaFocused(true)}
								onBlur={() => setTextareaFocused(false)}
								onPasteCapture={handlePaste}
							>
								<RichComposerInput
									ref={richRef}
									selfActorId={selfActorId}
									value={value}
									tags={richTags()}
									ariaLabel={textareaLabel ?? placeholder}
									ariaDescribedBy={hint === undefined ? undefined : hintId}
									placeholder={canWrite ? placeholder : VIEWER_READ_ONLY_MESSAGE}
									readOnly={
										disabled || secretFlow?.blocking === true || vaultFlow?.blocking === true
									}
									className="max-h-40 min-h-[28px]"
									onChange={(next) =>
										handleTagChange({ text: next.markdown, ids: next.mentionIds })
									}
									onTriggerChange={(trigger) =>
										setMentionTrigger(trigger ? { atPos: 0, query: trigger.query } : null)
									}
									onKeyDown={handleRichKeyDown}
									onActiveFormatsChange={setActiveFormats}
								/>
							</div>
						) : inlineTags ? (
							// Focus and paste are caught on the wrapper: the tag input has no hooks for them.
							<div
								ref={tagWrapRef}
								className="min-w-0 flex-1 px-1 py-1.5 max-md:py-2"
								onFocus={() => setTextareaFocused(true)}
								onBlur={() => setTextareaFocused(false)}
								onPasteCapture={handlePaste}
							>
								<TagInput
									handleRef={tagRef}
									workspaceId={workspaceId}
									conversationParticipantIds={conversationParticipantIds}
									selfActorId={selfActorId}
									initialSegments={initialTagContent.segments}
									surface="card"
									ariaLabel={textareaLabel ?? placeholder}
									ariaDescribedBy={hint === undefined ? undefined : hintId}
									placeholder={
										canWrite
											? dictation.recording
												? 'Listening'
												: placeholder
											: VIEWER_READ_ONLY_MESSAGE
									}
									disabled={
										disabled || secretFlow?.blocking === true || vaultFlow?.blocking === true
									}
									className="max-h-40 min-h-[28px] text-base"
									onChange={handleTagChange}
									onKeyDown={handleKeyDown}
								/>
							</div>
						) : (
							<Textarea
								autoResize
								ref={textareaRef}
								value={value}
								onChange={handleChange}
								onPaste={handlePaste}
								onKeyDown={handleKeyDown}
								placeholder={
									canWrite
										? dictation.recording
											? 'Listening'
											: placeholder
										: VIEWER_READ_ONLY_MESSAGE
								}
								className="max-h-40 min-h-10 min-w-0 flex-1 resize-none overflow-y-auto border-0 bg-transparent px-1 py-2 text-base focus-visible:ring-0 focus-visible:ring-offset-0 max-md:min-h-11 max-md:py-2.5 md:text-base"
								disabled={disabled || secretFlow?.blocking === true || vaultFlow?.blocking === true}
								rows={1}
								aria-label={textareaLabel}
								aria-describedby={hint === undefined ? undefined : hintId}
								onFocus={() => setTextareaFocused(true)}
								onBlur={() => setTextareaFocused(false)}
								aria-controls={mentionTrigger !== null ? 'mention-picker-listbox' : undefined}
								aria-expanded={mentionTrigger !== null || undefined}
							/>
						)}
						{callAgent ? (
							<span className="inline-flex shrink-0 self-center">
								<AgentCallButton agent={callAgent} variant="composer" shortcut={false} />
							</span>
						) : null}
						{/* One round action button: mic when empty, send when typed, bars while dictating. */}
						{actionMode === 'send' ? (
							<Button
								key="send"
								type="submit"
								size="icon"
								className={cn(
									'shrink-0 rounded-full max-md:size-11',
									canSend ? '' : 'bg-muted text-muted-foreground hover:bg-muted',
								)}
								disabled={!canSend}
								aria-label="Send message"
							>
								{showSpinner ? <Spinner /> : <ArrowUp size={18} aria-hidden />}
							</Button>
						) : (
							<Button
								key={actionMode}
								type="button"
								size="icon"
								className="shrink-0 rounded-full max-md:size-11"
								onClick={dictation.toggle}
								disabled={disabled || dictation.transcribing}
								aria-pressed={dictation.recording}
								aria-busy={dictation.transcribing}
								aria-label={
									actionMode === 'transcribing'
										? 'Transcribing'
										: actionMode === 'listening'
											? 'Stop dictating'
											: 'Dictate a message'
								}
							>
								{actionMode === 'transcribing' ? (
									<Spinner />
								) : actionMode === 'listening' ? (
									<span aria-hidden className="flex items-center gap-0.5">
										<span className="h-2 w-0.5 animate-pulse rounded-full bg-primary-foreground" />
										<span className="h-4 w-0.5 animate-pulse rounded-full bg-primary-foreground [animation-delay:150ms]" />
										<span className="h-3 w-0.5 animate-pulse rounded-full bg-primary-foreground [animation-delay:300ms]" />
									</span>
								) : (
									<Mic size={18} aria-hidden />
								)}
							</Button>
						)}
					</div>
					{sendError || externalError ? (
						<p role="alert" className="mt-2 px-4 text-error text-xs" aria-live="polite">
							{sendError ?? externalError} — your message is preserved; try again.
						</p>
					) : null}
					{hint === undefined ? null : (
						<output
							id={hintId}
							aria-live="polite"
							className={cn(
								'px-4 text-muted-foreground text-xs',
								// The icon and the 8 px gap above exist only while there is text, so the empty live
								// region adds no height.
								hintText ? 'mt-2 flex items-start gap-1.5' : 'block',
							)}
						>
							{hintText ? <Info aria-hidden className="mt-px size-3.5 shrink-0" /> : null}
							{hintText}
						</output>
					)}
				</form>
			</ViewerTooltip>
		</div>
	)
}
