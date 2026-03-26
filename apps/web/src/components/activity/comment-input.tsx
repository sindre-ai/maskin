import { Button } from '@/components/ui/button'
import { useActors } from '@/hooks/use-actors'
import { useCreateComment } from '@/hooks/use-events'
import { getStoredActor } from '@/lib/auth'
import { cn } from '@/lib/cn'
import { SendHorizontal } from 'lucide-react'
import { useCallback, useRef, useState } from 'react'
import { ActorAvatar } from '../shared/actor-avatar'

interface CommentInputProps {
	workspaceId: string
	objectId: string
	parentEventId?: number
	compact?: boolean
}

export function CommentInput({ workspaceId, objectId, parentEventId, compact }: CommentInputProps) {
	const actor = getStoredActor()
	const createComment = useCreateComment(workspaceId, objectId)
	const { data: actors } = useActors(workspaceId)

	const [content, setContent] = useState('')
	const [mentions, setMentions] = useState<string[]>([])
	const [showMentions, setShowMentions] = useState(false)
	const [mentionFilter, setMentionFilter] = useState('')
	const [selectedIndex, setSelectedIndex] = useState(0)

	const inputRef = useRef<HTMLTextAreaElement>(null)
	const mentionListRef = useRef<HTMLDivElement>(null)

	const filteredActors =
		actors?.filter(
			(a) => a.id !== actor?.id && a.name.toLowerCase().includes(mentionFilter.toLowerCase()),
		) ?? []

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

	const handleSubmit = useCallback(() => {
		const trimmed = content.trim()
		if (!trimmed) return

		createComment.mutate(
			{
				entity_id: objectId,
				content: trimmed,
				mentions: mentions.length > 0 ? mentions : undefined,
				parent_event_id: parentEventId,
			},
			{
				onSuccess: () => {
					setContent('')
					setMentions([])
				},
			},
		)
	}, [content, mentions, objectId, parentEventId, createComment])

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
				e.preventDefault()
				handleSubmit()
			}
		},
		[showMentions, filteredActors, selectedIndex, insertMention, handleSubmit],
	)

	if (!actor) return null

	return (
		<div className="relative">
			<div className={cn('flex items-start gap-2', compact ? 'gap-1.5' : 'gap-2')}>
				<ActorAvatar
					name={actor.name}
					type={actor.type}
					size={compact ? 'sm' : 'md'}
					className="mt-1.5"
				/>
				<div className="flex-1 relative">
					<textarea
						ref={inputRef}
						value={content}
						onChange={handleInput}
						onKeyDown={handleKeyDown}
						placeholder="Comment or instruct an agent..."
						rows={1}
						className={cn(
							'w-full resize-none rounded-md border border-border bg-transparent px-3 py-2 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-border-focus',
							compact && 'text-xs py-1.5 px-2',
						)}
						style={{ minHeight: compact ? '32px' : '38px' }}
					/>
				</div>
				<Button
					size="icon"
					variant="ghost"
					className={cn('shrink-0 mt-1', compact ? 'h-6 w-6' : 'h-8 w-8')}
					disabled={!content.trim() || createComment.isPending}
					onClick={handleSubmit}
				>
					<SendHorizontal size={compact ? 14 : 16} />
				</Button>
			</div>

			{/* @mention autocomplete dropdown */}
			{showMentions && filteredActors.length > 0 && (
				<div
					ref={mentionListRef}
					className="absolute left-7 z-50 mt-1 max-h-48 w-56 overflow-auto rounded-md border border-border bg-popover p-1 shadow-md"
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
