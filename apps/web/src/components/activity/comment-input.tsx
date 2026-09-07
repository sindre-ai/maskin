import { SlashPicker, type SlashPickerResult } from '@/components/chat/slash-picker'
import { Button } from '@/components/ui/button'
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { useActors } from '@/hooks/use-actors'
import { useDictation } from '@/hooks/use-dictation'
import { useCreateComment } from '@/hooks/use-events'
import { useIsMobile } from '@/hooks/use-mobile'
import { getStoredActor } from '@/lib/auth'
import { EMPTY_CHAT_SELECTION } from '@/lib/chat-selection'
import { cn } from '@/lib/cn'
import { getTypeColor } from '@/lib/constants'
import { formatSize } from '@/lib/file-utils'
import { useDraft } from '@/lib/pending-comments-context'
import { COMMENT_MAX_ATTACHMENTS, COMMENT_MAX_LENGTH } from '@maskin/shared'
import { ArrowUp, AtSign, Box, Mic, Paperclip, Plus, X } from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ActorAvatar } from '../shared/actor-avatar'
import { MentionedText } from '../shared/mentioned-text'
import { UploadProgress } from '../shared/upload-progress'

interface CommentInputProps {
	workspaceId: string
	objectId: string
	parentEventId?: number
	// Fires once the comment is actually on the server. Callers that take an
	// irreversible action on a reply (For You marks the thread read, which drops
	// the card) must use this one and not `onQueued`.
	onSubmitted?: () => void
	// Fires when a comment carrying attachments is handed to the pending-comments
	// queue, which uploads and POSTs in the background. The comment has NOT been
	// posted yet and may still fail, so this is for clearing local composer state
	// only. When it is not supplied the queued path stays silent rather than
	// falling back to `onSubmitted`, because a caller that never opted in would
	// otherwise treat a queued draft as a posted one.
	onQueued?: () => void
	// Direction the @-mention dropdown opens. Defaults to 'below' (object detail
	// page, plenty of room underneath). Callers pinned to the viewport bottom
	// (e.g. ForYouQueueCard) pass 'above' so the dropdown doesn't render
	// off-screen.
	mentionDropdownPlacement?: 'below' | 'above'
	// Optional external ownership of the textarea node. When set, the composer
	// forwards its textarea ref so callers can programmatically focus the answer
	// control (e.g. the ask banner's "Answer it ↓" button).
	focusRef?: React.Ref<HTMLTextAreaElement>
	// Replaces the composer's own keyboard hint in the control row. The mockup
	// gives this slot one line, so a caller with something more useful to say
	// (object detail names the agent that will read the comment) passes it here
	// rather than stacking a second line beneath the card.
	hint?: React.ReactNode
	// `stacked` is the feed composer: an avatar, a growing field, and a control
	// row carrying the hint. `bar` is the single-row composer the object detail
	// page pins to the bottom of its document (mockup 1358–1366) — no avatar, no
	// hint, controls inline with the field.
	variant?: 'stacked' | 'bar'
	// Overrides the composer's own placeholder. The bar reads
	// "Comment — / commands, @ mentions" on object detail.
	placeholder?: string
}

function randomDraftId(): string {
	if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID()
	return `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

// ~5 lines at text-base (line-height 24px) + py-1 (8px) + 2px border
const MAX_INPUT_HEIGHT_PX = 130

// Show the live character counter once the draft reaches this fraction of the
// limit. Keeps the UI quiet for the common short-comment case.
const COUNTER_VISIBILITY_THRESHOLD = 0.9

export function CommentInput({
	workspaceId,
	objectId,
	parentEventId,
	onSubmitted,
	onQueued,
	mentionDropdownPlacement = 'below',
	focusRef,
	hint,
	variant = 'stacked',
	placeholder,
}: CommentInputProps) {
	const isBar = variant === 'bar'
	const actor = getStoredActor()
	const createComment = useCreateComment(workspaceId, objectId)
	const { data: actors } = useActors(workspaceId)
	const isMobile = useIsMobile()

	const [content, setContent] = useState('')
	const [mentions, setMentions] = useState<string[]>([])
	const [showMentions, setShowMentions] = useState(false)
	const [mentionFilter, setMentionFilter] = useState('')
	const [selectedIndex, setSelectedIndex] = useState(0)
	const [isDraggingFile, setIsDraggingFile] = useState(false)
	// "Reference an object" reuses the composer's own picker rather than a
	// second search UI; the pick is inserted as the canonical markdown object
	// link the comment API documents (`[title](/<ws>/objects/<id>)`).
	const [objectPickerOpen, setObjectPickerOpen] = useState(false)
	// Objects picked from "Reference an object" ride the comment as chips and
	// land on the timeline as real references (mockup `refList`).
	const [references, setReferences] = useState<Array<{ id: string; title: string; type: string }>>(
		[],
	)

	const inputRef = useRef<HTMLTextAreaElement>(null)
	const overlayRef = useRef<HTMLDivElement>(null)
	const fileInputRef = useRef<HTMLInputElement>(null)

	// Merge the internal inputRef (which the resize / mention / scroll logic
	// reads) with an optional external focusRef so callers own the same node.
	const setTextareaRef = useCallback(
		(node: HTMLTextAreaElement | null) => {
			inputRef.current = node
			if (typeof focusRef === 'function') focusRef(node)
			else if (focusRef) focusRef.current = node
		},
		[focusRef],
	)

	// Stable per-mount draft id. The id is also used as the optimistic comment
	// entry id once submitted, so the activity feed can render its placeholder.
	const draftIdRef = useRef<string>(randomDraftId())
	const draftId = draftIdRef.current
	const draft = useDraft({ draftId, workspaceId, objectId, parentEventId })
	const attachments = draft.files
	const hasAttachments = attachments.length > 0
	const attachmentLimitReached = attachments.length >= COMMENT_MAX_ATTACHMENTS
	const isUploadingAny = attachments.some((f) => f.status === 'uploading')

	const fitHeight = useCallback(() => {
		const ta = inputRef.current
		if (!ta) return
		ta.style.height = 'auto'
		const overflows = ta.scrollHeight > MAX_INPUT_HEIGHT_PX
		ta.style.height = `${Math.min(ta.scrollHeight, MAX_INPUT_HEIGHT_PX)}px`
		ta.style.overflowY = overflows ? 'auto' : 'hidden'
	}, [])

	// biome-ignore lint/correctness/useExhaustiveDependencies: content drives the resize, including programmatic setContent (mention insert, post-submit reset)
	useLayoutEffect(() => {
		fitHeight()
	}, [content, fitHeight])

	// The field's own width also drives how many lines the draft wraps to, and
	// it settles after first paint — the bar composer shares its row with the
	// `+`, mic and send buttons, so measuring only on mount leaves the field
	// several lines too tall on a narrow viewport. Re-fit whenever it resizes.
	useLayoutEffect(() => {
		const ta = inputRef.current
		if (!ta || typeof ResizeObserver === 'undefined') return
		const observer = new ResizeObserver(() => fitHeight())
		observer.observe(ta)
		return () => observer.disconnect()
	}, [fitHeight])

	const handleScroll = useCallback(() => {
		const overlay = overlayRef.current
		const ta = inputRef.current
		if (overlay && ta) overlay.scrollTop = ta.scrollTop
	}, [])

	const mentionableActors = useMemo(
		() => actors?.filter((a) => a.id !== actor?.id && !a.isSystem) ?? [],
		[actors, actor?.id],
	)
	const filteredActors = useMemo(
		() =>
			mentionableActors.filter((a) => a.name.toLowerCase().includes(mentionFilter.toLowerCase())),
		[mentionableActors, mentionFilter],
	)

	const insertMention = useCallback(
		(actorId: string, actorName: string) => {
			const textarea = inputRef.current
			if (!textarea) return

			// Find the @ position to replace
			const cursorPos = textarea.selectionStart
			const textBefore = content.slice(0, cursorPos)
			const atIndex = textBefore.lastIndexOf('@')
			if (atIndex === -1) return

			const before = content.slice(0, atIndex)
			const after = content.slice(cursorPos)
			const newContent = `${before}@${actorName} ${after}`

			setContent(newContent)
			if (!mentions.includes(actorId)) {
				setMentions([...mentions, actorId])
			}
			setShowMentions(false)
			setMentionFilter('')

			// Focus back and set cursor after mention
			requestAnimationFrame(() => {
				textarea.focus()
				const newPos = atIndex + actorName.length + 2
				textarea.setSelectionRange(newPos, newPos)
			})
		},
		[content, mentions],
	)

	const handleInput = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
		const value = e.target.value
		setContent(value)

		// Check if we're in a mention context
		const cursorPos = e.target.selectionStart
		const textBefore = value.slice(0, cursorPos)
		const atIndex = textBefore.lastIndexOf('@')

		if (atIndex !== -1) {
			const textAfterAt = textBefore.slice(atIndex + 1)
			// Show mention dropdown if @ is at start or preceded by whitespace, and no space in the filter
			const charBeforeAt = atIndex > 0 ? textBefore[atIndex - 1] : ' '
			if (
				(charBeforeAt === ' ' || charBeforeAt === '\n' || atIndex === 0) &&
				!textAfterAt.includes(' ')
			) {
				setShowMentions(true)
				setMentionFilter(textAfterAt)
				setSelectedIndex(0)
				return
			}
		}
		setShowMentions(false)
		setMentionFilter('')
	}, [])

	// Appends dictated phrases to the draft. Renders nothing at all when the
	// browser has no SpeechRecognition — never a dead control.
	const dictation = useDictation(
		useCallback((text: string) => {
			setContent((prev) => (prev.length === 0 ? text : `${prev.trimEnd()} ${text}`))
		}, []),
	)

	// `trailingSpace` exists for the "@" opener: the mention dropdown stays open
	// only while the text after the "@" contains no space (see handleInput), so
	// seeding "@ " would close it on the very first keystroke.
	const insertAtCursor = useCallback((snippet: string, { trailingSpace = true } = {}) => {
		const textarea = inputRef.current
		setContent((prev) => {
			const pos = textarea?.selectionStart ?? prev.length
			const before = prev.slice(0, pos)
			const after = prev.slice(pos)
			const spacer = before.length > 0 && !/\s$/.test(before) ? ' ' : ''
			const tail = trailingSpace ? ' ' : ''
			const next = `${before}${spacer}${snippet}${tail}${after}`
			requestAnimationFrame(() => {
				const caret = before.length + spacer.length + snippet.length + tail.length
				textarea?.focus()
				textarea?.setSelectionRange(caret, caret)
			})
			return next
		})
	}, [])

	const handleObjectPicked = useCallback(
		(result: SlashPickerResult) => {
			if (result.kind === 'object') {
				const picked = {
					id: result.ref.id,
					title: result.ref.title?.trim() || 'Untitled',
					type: result.ref.type ?? 'object',
				}
				setReferences((prev) => (prev.some((r) => r.id === picked.id) ? prev : [...prev, picked]))
			} else if (result.kind === 'agent') {
				insertAtCursor(`@${result.ref.name}`)
				setMentions((prev) => (prev.includes(result.ref.id) ? prev : [...prev, result.ref.id]))
			}
			setObjectPickerOpen(false)
		},
		[insertAtCursor],
	)

	// Opens the @-mention flow the textarea already owns instead of a parallel
	// picker — one mention path, one dropdown.
	const startMention = useCallback(() => {
		insertAtCursor('@', { trailingSpace: false })
		setShowMentions(true)
		setMentionFilter('')
		setSelectedIndex(0)
	}, [insertAtCursor])

	// The one place a comment's structured extras are built. Both submit paths
	// — the direct POST and the attachment queue — spread this, so they cannot
	// drift apart.
	const buildMetadata = useCallback((): Record<string, unknown> | undefined => {
		const refs = references.map((r) => r.id)
		if (refs.length === 0) return undefined
		return { refs }
	}, [references])

	const overLimit = content.length > COMMENT_MAX_LENGTH
	const showCounter = content.length >= COMMENT_MAX_LENGTH * COUNTER_VISIBILITY_THRESHOLD

	const resetComposer = useCallback(() => {
		setContent('')
		setMentions([])
		setReferences([])
		draftIdRef.current = randomDraftId()
	}, [])

	const handleSubmit = useCallback(() => {
		const trimmed = content.trim()
		// References ride along with a comment, they are not a comment on their
		// own: `createCommentSchema.content` is `.min(1)`, so posting references
		// with an empty body is a guaranteed 400.
		if (!trimmed) return
		if (content.length > COMMENT_MAX_LENGTH) return
		// The Send button is already disabled while a POST is in flight; Enter has
		// to obey the same rule. The composer deliberately keeps its text until
		// the POST succeeds (so a rejected one is not lost), which means a slow
		// round trip looks exactly like a keypress that did nothing — and the
		// second Enter posts the same comment twice.
		if (createComment.isPending) return

		// Reconcile mentions: only include actors whose @Name is still in the text
		const activeMentions = mentions.filter((id) => {
			const actor = actors?.find((a) => a.id === id)
			return actor && trimmed.includes(`@${actor.name}`)
		})

		const metadata = buildMetadata()

		const postDirectly = () => {
			createComment.mutate(
				{
					entity_id: objectId,
					content: trimmed,
					mentions: activeMentions.length > 0 ? activeMentions : undefined,
					parent_event_id: parentEventId,
					...(metadata ? { metadata } : {}),
				},
				{
					onSuccess: () => {
						resetComposer()
						onSubmitted?.()
					},
				},
			)
		}

		if (hasAttachments) {
			// Hand the submission to the pending-comments queue. Uploads (if still
			// in flight) and the final POST will continue in the background even
			// if the user navigates away from this page. The queue carries the
			// same metadata the direct path sends, so an attachment and a
			// decision can ride one comment.
			const outcome = draft.submit({
				content: trimmed,
				mentions: activeMentions,
				...(metadata ? { metadata } : {}),
			})
			// The queue has nothing to send — the entry was never created, or every
			// attachment was removed between the `hasAttachments` read and this
			// click. It also deletes the entry in that second case, so there is no
			// queued row left to render a failure on. Post directly rather than
			// resetting the composer, which would clear the comment as if it sent.
			if (outcome === 'no-attachments') {
				postDirectly()
				return
			}
			resetComposer()
			// Deliberately not `onSubmitted` — the upload and the POST are still
			// ahead of us, and a queued comment can still fail. Telling the caller
			// it was submitted here let For You mark the thread read and drop the
			// card for a reply that was never sent.
			onQueued?.()
			return
		}

		postDirectly()
	}, [
		content,
		mentions,
		actors,
		objectId,
		parentEventId,
		createComment,
		onSubmitted,
		onQueued,
		hasAttachments,
		draft,
		buildMetadata,
		resetComposer,
	])

	const handleFilesPicked = useCallback(
		(files: FileList | File[] | null) => {
			if (!files) return
			const list = Array.from(files)
			for (const file of list) {
				if (draft.files.length >= COMMENT_MAX_ATTACHMENTS) break
				draft.attach(file)
			}
		},
		[draft],
	)

	const handleDrop = useCallback(
		(e: React.DragEvent) => {
			e.preventDefault()
			setIsDraggingFile(false)
			handleFilesPicked(e.dataTransfer.files)
		},
		[handleFilesPicked],
	)

	// If the composer unmounts before the user submits (e.g., page nav), drop
	// the draft so we don't leak abandoned uploads. Submitted drafts are owned
	// by the provider and survive — discardDraft is a no-op for non-'draft'
	// status, so resubmission isn't affected.
	const discardRef = useRef(draft.discard)
	discardRef.current = draft.discard
	useEffect(() => () => discardRef.current(), [])

	const handleKeyDown = useCallback(
		(e: React.KeyboardEvent<HTMLTextAreaElement>) => {
			if (showMentions && filteredActors.length > 0) {
				if (e.key === 'ArrowDown') {
					e.preventDefault()
					setSelectedIndex((i) => Math.min(i + 1, filteredActors.length - 1))
					return
				}
				if (e.key === 'ArrowUp') {
					e.preventDefault()
					setSelectedIndex((i) => Math.max(i - 1, 0))
					return
				}
				if (e.key === 'Enter' || e.key === 'Tab') {
					e.preventDefault()
					const selected = filteredActors[selectedIndex]
					if (selected) insertMention(selected.id, selected.name)
					return
				}
				if (e.key === 'Escape') {
					e.preventDefault()
					setShowMentions(false)
					return
				}
			}

			if (e.key === 'Enter' && !e.shiftKey) {
				// On touch-primary devices (iOS, mobile), let Enter insert a newline —
				// the soft keyboard's Enter is the source of accidental submits. The
				// Send button is the only submit path on these devices.
				if (typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches) {
					return
				}
				e.preventDefault()
				handleSubmit()
			}
		},
		[showMentions, filteredActors, selectedIndex, insertMention, handleSubmit],
	)

	if (!actor) return null

	// `+` menu and its object picker — shared by both composer layouts.
	const controlsLeft = (
		<>
			<SlashPicker
				workspaceId={workspaceId}
				open={objectPickerOpen}
				onOpenChange={setObjectPickerOpen}
				onSelect={handleObjectPicked}
				selected={EMPTY_CHAT_SELECTION}
				initialKindId="item"
				anchor={
					<span aria-hidden className="pointer-events-none absolute bottom-1 left-2 h-0 w-0" />
				}
			/>
			<DropdownMenu>
				<DropdownMenuTrigger asChild>
					<Button
						type="button"
						size="icon"
						variant="outline"
						className="h-7 w-7 shrink-0 rounded-full text-muted-foreground"
						aria-label="Add a file, object, or mention"
					>
						<Plus size={15} aria-hidden />
					</Button>
				</DropdownMenuTrigger>
				<DropdownMenuContent align="start" className="w-[250px]">
					<DropdownMenuItem
						disabled={attachmentLimitReached}
						onSelect={() => fileInputRef.current?.click()}
					>
						<Paperclip size={15} aria-hidden />
						Attach a file
					</DropdownMenuItem>
					<DropdownMenuItem
						// Opened on the next tick: the menu closes first, and its
						// focus-return would otherwise land as an outside-click on the
						// picker and shut it again the moment it mounts.
						onSelect={() => window.setTimeout(() => setObjectPickerOpen(true), 0)}
					>
						<Box size={15} aria-hidden />
						Reference an object
					</DropdownMenuItem>
					<DropdownMenuItem onSelect={startMention}>
						<AtSign size={15} aria-hidden />
						Mention an agent
					</DropdownMenuItem>
				</DropdownMenuContent>
			</DropdownMenu>
		</>
	)

	const controlsRight = (
		<>
			{dictation.supported ? (
				<Button
					type="button"
					size="icon"
					variant={dictation.recording ? 'destructive' : 'outline'}
					className={cn(
						'h-7 w-7 shrink-0 rounded-full',
						dictation.recording ? 'animate-pulse' : 'text-muted-foreground',
					)}
					onClick={dictation.toggle}
					aria-pressed={dictation.recording}
					aria-label={dictation.recording ? 'Stop dictating' : 'Dictate a comment'}
				>
					<Mic size={14} aria-hidden />
				</Button>
			) : null}
			<Button
				size="icon"
				variant="ghost"
				className="h-7 w-7 shrink-0 rounded-full"
				disabled={!content.trim() || createComment.isPending || overLimit}
				title={isUploadingAny ? 'Send (uploads continue in background)' : 'Send'}
				aria-label="Send comment"
				onClick={handleSubmit}
			>
				<ArrowUp size={14} />
			</Button>
		</>
	)

	const referenceChips = references.length > 0 && (
		<ul className={cn('flex flex-wrap gap-1.5', isBar ? 'px-1 pb-[7px]' : 'p-1.5 pb-0')}>
			{references.map((ref) => (
				<li
					key={ref.id}
					className={cn(
						'flex items-center gap-1.5',
						isBar
							? 'rounded-full border border-brand/25 bg-brand/10 px-2.5 py-1'
							: 'rounded-lg border border-border bg-background px-2 py-1',
					)}
				>
					<span
						aria-hidden="true"
						className={cn('size-[7px] shrink-0 rounded-[2px]', getTypeColor(ref.type).bg)}
					/>
					{!isBar && (
						<span className="font-mono text-[8px] font-bold uppercase tracking-[0.09em] text-muted-foreground">
							{ref.type}
						</span>
					)}
					<span
						className={cn(
							'max-w-[180px] truncate text-[11.5px] font-semibold',
							isBar ? 'text-brand' : 'text-foreground',
						)}
					>
						{ref.title}
					</span>
					<button
						type="button"
						aria-label={`Remove reference to ${ref.title}`}
						onClick={() => setReferences((prev) => prev.filter((r) => r.id !== ref.id))}
						className={cn(
							'transition-colors',
							isBar ? 'text-brand/45 hover:text-brand' : 'text-border hover:text-destructive',
						)}
					>
						<X size={12} />
					</button>
				</li>
			))}
		</ul>
	)

	return (
		<div
			className={cn(
				'relative rounded-md transition-colors',
				isDraggingFile && 'bg-accent/5 ring-1 ring-accent/40',
			)}
			onDragOver={(e) => {
				if (!e.dataTransfer.types.includes('Files')) return
				e.preventDefault()
				if (!isDraggingFile) setIsDraggingFile(true)
			}}
			onDragLeave={(e) => {
				if (e.currentTarget.contains(e.relatedTarget as Node)) return
				setIsDraggingFile(false)
			}}
			onDrop={handleDrop}
		>
			<div className={cn('flex items-start gap-2', isBar && 'gap-0')}>
				{!isBar && <ActorAvatar name={actor.name} type={actor.type} size="sm" className="mt-1" />}
				{/* min-w-0 lets the flex child shrink below its textarea's intrinsic
				    content width — without it, a long unbroken token (URL, paste)
				    pushes the row past the card and the page scrolls horizontally
				    instead of the field growing vertically. */}
				<div className="min-w-0 flex-1">
					{isBar && referenceChips}
					<div
						className={cn(
							'border transition-colors',
							isBar ? 'rounded-2xl bg-background shadow-sm' : 'rounded-md',
							overLimit ? 'border-error' : isBar ? 'border-input' : 'border-border',
						)}
					>
						{!isBar && referenceChips}
						{hasAttachments && (
							<ul className="flex flex-wrap gap-1.5 p-1.5">
								{attachments.map((file) => (
									<li
										key={file.tempId}
										className="flex items-center gap-2 rounded-md border border-border bg-card px-2 py-1 text-xs"
									>
										<UploadProgress
											progress={file.progress}
											status={file.status}
											error={file.error}
										/>
										<span className="max-w-[160px] truncate font-medium">{file.name}</span>
										<span className="font-mono text-muted-foreground">
											{formatSize(file.sizeBytes)}
										</span>
										<button
											type="button"
											onClick={() => draft.remove(file.tempId)}
											aria-label={`Remove ${file.name}`}
											className="text-muted-foreground hover:text-foreground"
										>
											<X size={12} />
										</button>
									</li>
								))}
							</ul>
						)}
						<div className={cn(isBar && 'flex items-center gap-2 px-2 py-1.5')}>
							{isBar && controlsLeft}
							<div className={cn('relative', isBar && 'min-w-0 flex-1')}>
								<div
									ref={overlayRef}
									aria-hidden
									className="pointer-events-none absolute inset-0 overflow-hidden whitespace-pre-wrap break-words px-2 py-1 text-base"
									style={{ minHeight: '28px' }}
								>
									<MentionedText
										content={content}
										actors={mentionableActors}
										mentionClassName="rounded bg-primary/10 text-primary"
									/>
									{/* Trailing zero-width space keeps the overlay height in sync when content ends with a newline */}
									{content.endsWith('\n') && '​'}
								</div>
								{/* wrap="soft" + break-words match the overlay's whitespace-pre-wrap
							    break-words so the textarea's scrollHeight (which the
							    useLayoutEffect resize reads) reflects the wrapped layout
							    instead of one runaway line. text-base stays for the iOS
							    Safari zoom-on-focus guard (#655). */}
								<textarea
									ref={setTextareaRef}
									value={content}
									onChange={handleInput}
									onKeyDown={handleKeyDown}
									onScroll={handleScroll}
									placeholder={
										placeholder ??
										(isMobile
											? 'Write a comment...'
											: 'Write a comment... Use @ to mention an agent')
									}
									rows={1}
									wrap="soft"
									aria-invalid={overLimit || undefined}
									className="relative w-full resize-none overflow-x-hidden overflow-y-hidden break-words border-0 bg-transparent px-2 py-1 text-base text-transparent placeholder:text-muted-foreground caret-foreground focus:outline-none focus:ring-0"
									style={{ minHeight: '28px', maxHeight: `${MAX_INPUT_HEIGHT_PX}px` }}
								/>
							</div>
							{isBar && controlsRight}
						</div>
						{/* Control row — `+` menu, hint, mic, send (mockup 457–472). The
						    bar variant hoists these controls up beside the field
						    instead, so this row renders only when stacked. */}
						{!isBar && (
							<div className="flex items-center gap-2 px-1.5 pb-1.5">
								{controlsLeft}
								<span className="min-w-0 flex-1 truncate text-[11.5px] text-muted-foreground">
									{hint ??
										(isMobile ? 'Tap ↑ to send' : 'Enter to send · @ to mention · + to attach')}
								</span>
								{controlsRight}
							</div>
						)}
					</div>
					{showCounter && (
						<div
							className={cn(
								'mt-1 text-right text-xs tabular-nums',
								overLimit ? 'text-error' : 'text-muted-foreground',
							)}
							aria-live="polite"
						>
							{content.length} / {COMMENT_MAX_LENGTH}
						</div>
					)}
				</div>
				<input
					ref={fileInputRef}
					type="file"
					multiple
					className="hidden"
					onChange={(e) => {
						handleFilesPicked(e.target.files)
						e.target.value = ''
					}}
				/>
			</div>

			{/* @mention autocomplete dropdown */}
			{showMentions && filteredActors.length > 0 && (
				<div
					className={cn(
						'absolute left-7 z-50 max-h-48 w-56 overflow-auto rounded-md border border-border bg-popover p-1 shadow-md',
						mentionDropdownPlacement === 'above' ? 'bottom-full mb-1' : 'mt-1',
					)}
				>
					{filteredActors.map((a, i) => (
						<button
							key={a.id}
							type="button"
							className={cn(
								'flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm',
								i === selectedIndex ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/50',
							)}
							onMouseDown={(e) => {
								e.preventDefault()
								insertMention(a.id, a.name)
							}}
							onMouseEnter={() => setSelectedIndex(i)}
						>
							<ActorAvatar name={a.name} type={a.type} size="sm" />
							<span className="truncate">{a.name}</span>
							<span className="ml-auto text-xs text-muted-foreground">{a.type}</span>
						</button>
					))}
				</div>
			)}
		</div>
	)
}
