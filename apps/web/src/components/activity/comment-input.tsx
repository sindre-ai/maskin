import { SlashPicker, type SlashPickerResult } from '@/components/chat/slash-picker'
import { TagInput, type TagInputHandle } from '@/components/chat/tag-input'
import { Button } from '@/components/ui/button'
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { useDictation } from '@/hooks/use-dictation'
import { useCreateComment } from '@/hooks/use-events'
import { useIsMobile } from '@/hooks/use-mobile'
import { getStoredActor } from '@/lib/auth'
import { EMPTY_CHAT_SELECTION } from '@/lib/chat-selection'
import { cn } from '@/lib/cn'
import { getTypeColor } from '@/lib/constants'
import { formatSize } from '@/lib/file-utils'
import { useDraft } from '@/lib/pending-comments-context'
import type { TagValue } from '@/lib/tag-input-model'
import { COMMENT_MAX_ATTACHMENTS, COMMENT_MAX_LENGTH } from '@maskin/shared'
import { ArrowUp, AtSign, Box, Mic, Paperclip, Plus, X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { ActorAvatar } from '../shared/actor-avatar'
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
	// Optional external ownership of the input. When set, the composer forwards
	// the tag input's handle so callers can programmatically focus the answer
	// control (e.g. the ask banner's "Answer it ↓" button).
	focusRef?: React.Ref<TagInputHandle>
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

// Show the live character counter once the draft reaches this fraction of the
// limit. Keeps the UI quiet for the common short-comment case.
const COUNTER_VISIBILITY_THRESHOLD = 0.9

export function CommentInput({
	workspaceId,
	objectId,
	parentEventId,
	onSubmitted,
	onQueued,
	focusRef,
	hint,
	variant = 'stacked',
	placeholder,
}: CommentInputProps) {
	const isBar = variant === 'bar'
	const actor = getStoredActor()
	const createComment = useCreateComment(workspaceId, objectId)
	const isMobile = useIsMobile()

	// What the tag input holds: the text (a tag reads "@Name") and the ids of the tags that went
	// through the picker. Only those ids are sent, so a typed "@name" notifies nobody.
	const [value, setValue] = useState<TagValue>({ text: '', ids: [] })
	const content = value.text
	const mentions = value.ids
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

	const tagRef = useRef<TagInputHandle>(null)
	const fileInputRef = useRef<HTMLInputElement>(null)

	// Merge the internal tagRef (which the dictation / mention logic reads) with
	// an optional external focusRef so callers own the same handle.
	const setTagHandle = useCallback(
		(handle: TagInputHandle | null) => {
			tagRef.current = handle
			if (typeof focusRef === 'function') focusRef(handle)
			else if (focusRef) focusRef.current = handle
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

	// Appends the dictated transcript to the draft. Renders nothing at all when
	// the browser cannot record audio — never a dead control.
	const dictation = useDictation(
		useCallback((text: string) => tagRef.current?.appendText(text), []),
		workspaceId,
		// The clean pass only replaces the streamed text while it is untouched.
		useCallback(
			(streamed: string, refined: string) => tagRef.current?.replaceText(streamed, refined),
			[],
		),
	)

	const handleObjectPicked = useCallback((result: SlashPickerResult) => {
		if (result.kind === 'object') {
			const picked = {
				id: result.ref.id,
				title: result.ref.title?.trim() || 'Untitled',
				type: result.ref.type ?? 'object',
			}
			setReferences((prev) => (prev.some((r) => r.id === picked.id) ? prev : [...prev, picked]))
		} else if (result.kind === 'agent') {
			tagRef.current?.insertTag(result.ref)
		}
		setObjectPickerOpen(false)
	}, [])

	// Opens the same picker the field opens when you type "@": one mention path.
	// It waits for the menu to close and decide where focus goes, then takes focus
	// itself — the menu would otherwise hand it back to the + button.
	const startTagAfterMenu = useRef(false)
	const startMention = useCallback(() => {
		startTagAfterMenu.current = true
	}, [])

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
		tagRef.current?.clear()
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

		// The tag input keeps the id list in step with its chips, so a tag that was
		// deleted is already gone from it.
		const activeMentions = mentions

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

	// The tag input handles the picker's keys, Shift+Enter and chips itself; this
	// is what is left: Enter sends.
	const handleKeyDown = useCallback(
		(e: React.KeyboardEvent<HTMLDivElement>) => {
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
		[handleSubmit],
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
				<DropdownMenuContent
					align="start"
					className="w-[250px]"
					onCloseAutoFocus={(e) => {
						if (!startTagAfterMenu.current) return
						startTagAfterMenu.current = false
						e.preventDefault()
						tagRef.current?.startTag()
					}}
				>
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
					disabled={dictation.transcribing}
					aria-pressed={dictation.recording}
					aria-busy={dictation.transcribing}
					aria-label={
						dictation.transcribing
							? 'Transcribing'
							: dictation.recording
								? 'Stop dictating'
								: 'Dictate a comment'
					}
				>
					{dictation.transcribing ? <Spinner /> : <Mic size={14} aria-hidden />}
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
							<TagInput
								workspaceId={workspaceId}
								selfActorId={actor.id}
								initialSegments={[]}
								handleRef={setTagHandle}
								ariaLabel="Comment"
								placeholder={
									placeholder ??
									(isMobile ? 'Write a comment...' : 'Write a comment... Use @ to mention an agent')
								}
								className={cn(
									'min-h-7 max-h-[50vh] px-2 py-1 text-base',
									isBar && 'min-w-0 flex-1',
									overLimit && 'text-error',
								)}
								invalid={overLimit}
								onChange={setValue}
								onKeyDown={handleKeyDown}
							/>
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
		</div>
	)
}
