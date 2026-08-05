import { Button } from '@/components/ui/button'
import { useActors } from '@/hooks/use-actors'
import { useCreateComment } from '@/hooks/use-events'
import { getStoredActor } from '@/lib/auth'
import { cn } from '@/lib/cn'
import { formatSize } from '@/lib/file-utils'
import { useDraft } from '@/lib/pending-comments-context'
import { COMMENT_MAX_ATTACHMENTS, COMMENT_MAX_LENGTH } from '@maskin/shared'
import { ArrowUp, Paperclip, X } from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ActorAvatar } from '../shared/actor-avatar'
import { MentionedText } from '../shared/mentioned-text'
import { UploadProgress } from '../shared/upload-progress'

interface CommentInputProps {
	workspaceId: string
	objectId: string
	parentEventId?: number
	onSubmitted?: () => void
	// Direction the @-mention dropdown opens. Defaults to 'below' (object detail
	// page, plenty of room underneath). Callers pinned to the viewport bottom
	// (e.g. ForYouQueueCard) pass 'above' so the dropdown doesn't render
	// off-screen.
	mentionDropdownPlacement?: 'below' | 'above'
}

function randomDraftId(): string {
	if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID()
	return `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

// ~5 lines at text-base (line-height 24px) + py-1.5 (12px) + 2px border
const MAX_INPUT_HEIGHT_PX = 134

// Show the live character counter once the draft reaches this fraction of the
// limit. Keeps the UI quiet for the common short-comment case.
const COUNTER_VISIBILITY_THRESHOLD = 0.9

export function CommentInput({
	workspaceId,
	objectId,
	parentEventId,
	onSubmitted,
	mentionDropdownPlacement = 'below',
}: CommentInputProps) {
	const actor = getStoredActor()
	const createComment = useCreateComment(workspaceId, objectId)
	const { data: actors } = useActors(workspaceId)

	const [content, setContent] = useState('')
	const [mentions, setMentions] = useState<string[]>([])
	const [showMentions, setShowMentions] = useState(false)
	const [mentionFilter, setMentionFilter] = useState('')
	const [selectedIndex, setSelectedIndex] = useState(0)
	const [isDraggingFile, setIsDraggingFile] = useState(false)

	const inputRef = useRef<HTMLTextAreaElement>(null)
	const overlayRef = useRef<HTMLDivElement>(null)
	const fileInputRef = useRef<HTMLInputElement>(null)

	// Stable per-mount draft id. The id is also used as the optimistic comment
	// entry id once submitted, so the activity feed can render its placeholder.
	const draftIdRef = useRef<string>(randomDraftId())
	const draftId = draftIdRef.current
	const draft = useDraft({ draftId, workspaceId, objectId, parentEventId })
	const attachments = draft.files
	const hasAttachments = attachments.length > 0
	const attachmentLimitReached = attachments.length >= COMMENT_MAX_ATTACHMENTS
	const isUploadingAny = attachments.some((f) => f.status === 'uploading')

	// biome-ignore lint/correctness/useExhaustiveDependencies: content drives the resize, including programmatic setContent (mention insert, post-submit reset)
	useLayoutEffect(() => {
		const ta = inputRef.current
		if (!ta) return
		ta.style.height = 'auto'
		const overflows = ta.scrollHeight > MAX_INPUT_HEIGHT_PX
		ta.style.height = `${Math.min(ta.scrollHeight, MAX_INPUT_HEIGHT_PX)}px`
		ta.style.overflowY = overflows ? 'auto' : 'hidden'
	}, [content])

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

	const overLimit = content.length > COMMENT_MAX_LENGTH
	const showCounter = content.length >= COMMENT_MAX_LENGTH * COUNTER_VISIBILITY_THRESHOLD

	const resetComposer = useCallback(() => {
		setContent('')
		setMentions([])
		draftIdRef.current = randomDraftId()
	}, [])

	const handleSubmit = useCallback(() => {
		const trimmed = content.trim()
		if (!trimmed) return
		if (content.length > COMMENT_MAX_LENGTH) return

		// Reconcile mentions: only include actors whose @Name is still in the text
		const activeMentions = mentions.filter((id) => {
			const actor = actors?.find((a) => a.id === id)
			return actor && trimmed.includes(`@${actor.name}`)
		})

		if (hasAttachments) {
			// Hand the submission to the pending-comments queue. Uploads (if still
			// in flight) and the final POST will continue in the background even
			// if the user navigates away from this page.
			draft.submit({ content: trimmed, mentions: activeMentions })
			resetComposer()
			onSubmitted?.()
			return
		}

		createComment.mutate(
			{
				entity_id: objectId,
				content: trimmed,
				mentions: activeMentions.length > 0 ? activeMentions : undefined,
				parent_event_id: parentEventId,
			},
			{
				onSuccess: () => {
					resetComposer()
					onSubmitted?.()
				},
			},
		)
	}, [
		content,
		mentions,
		actors,
		objectId,
		parentEventId,
		createComment,
		onSubmitted,
		hasAttachments,
		draft,
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
			<div className="flex items-start gap-2">
				<ActorAvatar name={actor.name} type={actor.type} size="sm" className="mt-1" />
				{/* min-w-0 lets the flex child shrink below its textarea's intrinsic
				    content width — without it, a long unbroken token (URL, paste)
				    pushes the row past the card and the page scrolls horizontally
				    instead of the field growing vertically. */}
				<div className="min-w-0 flex-1">
					<div
						className={cn(
							'rounded-md border transition-colors',
							overLimit ? 'border-error' : 'border-border',
						)}
					>
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
						<div className="relative">
							<div
								ref={overlayRef}
								aria-hidden
								className="pointer-events-none absolute inset-0 overflow-hidden whitespace-pre-wrap break-words px-2 py-1.5 text-base"
								style={{ minHeight: '32px' }}
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
								ref={inputRef}
								value={content}
								onChange={handleInput}
								onKeyDown={handleKeyDown}
								onScroll={handleScroll}
								placeholder="Write a comment... Use @ to mention an agent"
								rows={1}
								wrap="soft"
								aria-invalid={overLimit || undefined}
								className="relative w-full resize-none overflow-x-hidden overflow-y-hidden break-words border-0 bg-transparent px-2 py-1.5 text-base text-transparent placeholder:text-muted-foreground caret-foreground focus:outline-none focus:ring-0"
								style={{ minHeight: '32px', maxHeight: `${MAX_INPUT_HEIGHT_PX}px` }}
							/>
						</div>
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
				<Button
					size="icon"
					variant="ghost"
					className="shrink-0 h-8 w-8"
					disabled={attachmentLimitReached}
					title={
						attachmentLimitReached
							? `Maximum ${COMMENT_MAX_ATTACHMENTS} attachments`
							: 'Attach file'
					}
					aria-label="Attach file"
					onClick={() => fileInputRef.current?.click()}
				>
					<Paperclip size={14} />
				</Button>
				<Button
					size="icon"
					variant="ghost"
					className="shrink-0 h-8 w-8"
					disabled={!content.trim() || createComment.isPending || overLimit}
					title={isUploadingAny ? 'Send (uploads continue in background)' : 'Send'}
					aria-label="Send comment"
					onClick={handleSubmit}
				>
					<ArrowUp size={14} />
				</Button>
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
