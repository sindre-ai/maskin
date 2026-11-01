import {
	MentionPicker,
	type MentionPickerActor,
	buildMentionSections,
	detectMentionTrigger,
	reduceMentionPickerKey,
} from '@/components/chat/mention-picker'
import { type TagChipSurface, tagChipClass } from '@/components/chat/tag-chip'
import { useActors } from '@/hooks/use-actors'
import { useConversationsInfinite } from '@/hooks/use-conversations'
import { cn } from '@/lib/cn'
import {
	TAG_ID_ATTR,
	TAG_LABEL_ATTR,
	type TagSegment,
	type TagValue,
	isTagChip,
	pointAtTextOffset,
	readTagDom,
	tagLabel,
	textOffsetOfPoint,
} from '@/lib/tag-input-model'
import {
	type KeyboardEvent,
	type Ref,
	useCallback,
	useEffect,
	useImperativeHandle,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from 'react'

/**
 * `<TagInput>` — a text box where an `@` tag is a chip inside the sentence (Slack style).
 *
 * Editable DOM, not a textarea: text nodes, line breaks and atomic chip spans. Typing `@` at the
 * start of a word opens the existing MentionPicker; picking replaces the `@query` with a chip plus
 * one space. A chip is one unit (Backspace removes all of it) and carries the actor id. Paste is
 * plain text, so a typed or pasted "@name" never becomes a chip and never joins the id list.
 *
 * Uncontrolled: `initialSegments` is read once. The parent hears every change through `onChange`
 * with the plain text (chips as "@Name") and the ordered, de-duplicated id list.
 */

export interface TagInputHandle {
	focus: () => void
	/** Replaces everything in the input and reports the new value through `onChange`. */
	setContent: (segments: TagSegment[]) => void
	/** The caret as an offset into the plain text (a chip counts as "@Name"), or null when the
	 *  caret is not in the input. */
	caretOffset: () => number | null
	setCaretOffset: (offset: number) => void
}

export interface TagInputProps {
	workspaceId: string
	/** Participants of the open conversation, for the picker's first section. */
	conversationParticipantIds?: string[]
	selfActorId: string | null
	initialSegments: TagSegment[]
	surface?: TagChipSurface
	ariaLabel: string
	ariaDescribedBy?: string
	ariaActiveDescendant?: string
	placeholder: string
	disabled?: boolean
	autoFocus?: boolean
	/** Sizes the box (min and max height). */
	className?: string
	/** Padding for the text and the placeholder, so both start at the same spot. */
	contentClassName?: string
	onChange: (value: TagValue) => void
	/** Keys the input did not use itself (the picker, chips and Shift+Enter come first). */
	onKeyDown?: (e: KeyboardEvent<HTMLDivElement>) => void
	handleRef?: Ref<TagInputHandle>
}

interface Trigger {
	node: Text
	atPos: number
	query: string
}

export function TagInput({
	workspaceId,
	conversationParticipantIds,
	selfActorId,
	initialSegments,
	surface = 'card',
	ariaLabel,
	ariaDescribedBy,
	ariaActiveDescendant,
	placeholder,
	disabled = false,
	autoFocus = false,
	className,
	contentClassName,
	onChange,
	onKeyDown,
	handleRef,
}: TagInputProps) {
	const rootRef = useRef<HTMLDivElement | null>(null)
	const [empty, setEmpty] = useState(() => initialIsEmpty(initialSegments))
	const [trigger, setTrigger] = useState<Trigger | null>(null)
	const [highlightIndex, setHighlightIndex] = useState(0)

	const { data: workspaceActors } = useActors(workspaceId, { enabled: true })
	const pool = useMemo<MentionPickerActor[]>(
		() =>
			(workspaceActors ?? [])
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
	const conversations = useMemo(
		() => conversationPages?.pages.flatMap((p) => p.conversations) ?? [],
		[conversationPages],
	)
	const flatRows = useMemo(
		() =>
			buildMentionSections({
				actors: pool,
				conversations,
				conversationParticipantIds: conversationParticipantIds ?? [],
				query: trigger?.query ?? '',
				selfActorId,
			}).flatMap((s) => s.rows),
		[pool, conversations, conversationParticipantIds, trigger?.query, selfActorId],
	)
	// biome-ignore lint/correctness/useExhaustiveDependencies: the length is what resets the highlight.
	useEffect(() => {
		setHighlightIndex(0)
	}, [flatRows.length])

	const open = trigger !== null

	// Build the starting content once, before first paint.
	// biome-ignore lint/correctness/useExhaustiveDependencies: initial content is read once by design.
	useLayoutEffect(() => {
		const root = rootRef.current
		if (!root) return
		fillRoot(root, initialSegments, surface, selfActorId)
		if (autoFocus) {
			root.focus()
			placeCaretAtEnd(root)
		}
	}, [])

	// The picker follows the caret: an `@query` ending at the caret, in the text node it sits in.
	// A caret outside this input leaves the picker alone, so the phone sheet survives taking focus.
	const syncTrigger = useCallback(() => {
		const root = rootRef.current
		const sel = document.getSelection()
		if (!root || !sel || sel.rangeCount === 0 || !sel.isCollapsed) return
		const node = sel.anchorNode
		if (!node || !root.contains(node)) return
		if (node.nodeType !== 3) return setTrigger(null)
		const match = detectMentionTrigger((node as Text).data, sel.anchorOffset)
		setTrigger(match ? { node: node as Text, atPos: match.atPos, query: match.query } : null)
	}, [])
	useEffect(() => {
		document.addEventListener('selectionchange', syncTrigger)
		return () => document.removeEventListener('selectionchange', syncTrigger)
	}, [syncTrigger])

	const emit = useCallback(() => {
		const root = rootRef.current
		if (!root) return
		// Browsers leave a lone <br> behind when the last character goes; that is still empty.
		if (!root.querySelector(`[${TAG_ID_ATTR}]`) && root.textContent === '') {
			if (root.childNodes.length <= 1) root.replaceChildren()
		}
		const value = readTagDom(root)
		setEmpty(value.text.length === 0 && value.ids.length === 0)
		onChange(value)
		syncTrigger()
	}, [onChange, syncTrigger])

	useImperativeHandle(
		handleRef,
		() => ({
			focus: () => {
				const root = rootRef.current
				if (!root) return
				root.focus()
				placeCaretAtEnd(root)
			},
			setContent: (segments) => {
				const root = rootRef.current
				if (!root) return
				fillRoot(root, segments, surface, selfActorId)
				emit()
			},
			caretOffset: () => {
				const root = rootRef.current
				const sel = document.getSelection()
				if (!root || !sel || sel.rangeCount === 0 || !sel.anchorNode) return null
				return textOffsetOfPoint(root, sel.anchorNode, sel.anchorOffset)
			},
			setCaretOffset: (offset) => {
				const root = rootRef.current
				if (!root) return
				const point = pointAtTextOffset(root, offset)
				if (!point) return placeCaretAtEnd(root)
				const range = document.createRange()
				range.setStart(point.node, point.offset)
				range.collapse(true)
				const sel = document.getSelection()
				sel?.removeAllRanges()
				sel?.addRange(range)
			},
		}),
		[emit, surface, selfActorId],
	)

	const commit = useCallback(
		(actor: MentionPickerActor) => {
			const root = rootRef.current
			const current = trigger
			if (!root || !current || !current.node.isConnected) return setTrigger(null)
			const { node, atPos, query } = current
			const before = node.data.slice(0, atPos)
			const after = node.data.slice(atPos + 1 + query.length)
			const chip = buildChip(actor.id, tagLabel(actor, pool), surface, actor.id === selfActorId)
			const tail = document.createTextNode(after.startsWith(' ') ? after : ` ${after}`)
			node.data = before
			node.after(chip)
			chip.after(tail)
			if (before === '') node.remove()
			// The phone sheet hands focus back as it closes; put the caret back once it has.
			const placeCaret = () => {
				if (!tail.isConnected) return
				root.focus()
				const range = document.createRange()
				range.setStart(tail, Math.min(1, tail.data.length))
				range.collapse(true)
				const sel = document.getSelection()
				sel?.removeAllRanges()
				sel?.addRange(range)
			}
			placeCaret()
			requestAnimationFrame(placeCaret)
			setTrigger(null)
			emit()
		},
		[trigger, pool, surface, selfActorId, emit],
	)

	const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
		// An Enter that confirms an IME candidate is not ours, nor the parent's.
		if (e.nativeEvent.isComposing || e.key === 'Process') return
		if (trigger) {
			const result = reduceMentionPickerKey(
				{ key: e.key },
				{ flatCount: flatRows.length, highlightIndex },
			)
			if (result.handled) {
				if (result.preventDefault) e.preventDefault()
				// The first Esc only closes the picker; the parent never sees it.
				e.stopPropagation()
				const action = result.action
				if (action?.type === 'move') setHighlightIndex(action.nextIndex)
				else if (action?.type === 'commit') {
					const target = flatRows[action.index]
					if (target) commit(target)
				} else if (action?.type === 'close') setTrigger(null)
				return
			}
		}
		if ((e.key === 'Backspace' || e.key === 'Delete') && removeAdjacentChip(e.key === 'Delete')) {
			e.preventDefault()
			emit()
			return
		}
		if (e.key === 'Enter' && e.shiftKey) {
			e.preventDefault()
			insertPlainText('\n')
			emit()
			return
		}
		onKeyDown?.(e)
	}

	return (
		<>
			<div className={cn('relative', className)}>
				{empty ? (
					<span
						aria-hidden
						className={cn(
							'pointer-events-none absolute inset-0 select-none text-muted-foreground',
							contentClassName,
						)}
					>
						{placeholder}
					</span>
				) : null}
				<div
					ref={rootRef}
					role="textbox"
					tabIndex={disabled ? -1 : 0}
					contentEditable={!disabled}
					suppressContentEditableWarning
					aria-multiline="true"
					aria-label={ariaLabel}
					aria-describedby={ariaDescribedBy}
					aria-activedescendant={ariaActiveDescendant}
					aria-disabled={disabled || undefined}
					aria-haspopup="listbox"
					aria-expanded={open}
					spellCheck
					className={cn(
						'min-h-[inherit] max-h-[inherit] overflow-y-auto whitespace-pre-wrap break-words outline-none',
						contentClassName,
					)}
					onInput={emit}
					onClick={syncTrigger}
					onKeyDown={handleKeyDown}
					onPaste={(e) => {
						e.preventDefault()
						insertPlainText(e.clipboardData.getData('text/plain'))
						emit()
					}}
					// Dropped text or markup would bring unmarked formatting in; typing and paste cover it.
					onDrop={(e) => e.preventDefault()}
				/>
			</div>
			<MentionPicker
				open={open}
				onOpenChange={(next) => {
					if (!next) setTrigger(null)
				}}
				actors={pool}
				conversationParticipantIds={conversationParticipantIds ?? []}
				query={trigger?.query ?? ''}
				workspaceId={workspaceId}
				selfActorId={selfActorId}
				onSelect={commit}
				highlightIndex={highlightIndex}
				onHighlightChange={setHighlightIndex}
				// Pinned to the bottom of the nearest positioned ancestor, so the picker opens
				// under the whole card rather than over its footer.
				anchor={
					<span aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 h-0" />
				}
			/>
		</>
	)
}

function initialIsEmpty(segments: TagSegment[]): boolean {
	return segments.every((s) => s.kind === 'text' && s.text.length === 0)
}

function fillRoot(
	root: HTMLElement,
	segments: TagSegment[],
	surface: TagChipSurface,
	selfActorId: string | null,
) {
	root.replaceChildren()
	for (const segment of segments) {
		if (segment.kind === 'chip') {
			root.appendChild(buildChip(segment.id, segment.label, surface, segment.id === selfActorId))
		} else {
			appendText(root, segment.text)
		}
	}
}

function buildChip(id: string, label: string, surface: TagChipSurface, isSelf: boolean) {
	const chip = document.createElement('span')
	chip.contentEditable = 'false'
	chip.setAttribute(TAG_ID_ATTR, id)
	chip.setAttribute(TAG_LABEL_ATTR, label)
	chip.className = tagChipClass(surface, isSelf)
	chip.textContent = `@${label}`
	return chip
}

/** Text with "\n" becomes text nodes and line breaks. */
function appendText(root: HTMLElement, text: string) {
	text.split('\n').forEach((line, index) => {
		if (index > 0) root.appendChild(document.createElement('br'))
		if (line) root.appendChild(document.createTextNode(line))
	})
}

function placeCaretAtEnd(root: HTMLElement) {
	const range = document.createRange()
	range.selectNodeContents(root)
	range.collapse(false)
	const sel = document.getSelection()
	sel?.removeAllRanges()
	sel?.addRange(range)
}

/** Paste and Shift+Enter. The browser's own editing commands keep undo working; where they are
 *  missing or refuse, the same change is made by hand. */
function insertPlainText(text: string) {
	const lines = text.replace(/\r\n?/g, '\n').split('\n')
	lines.forEach((line, index) => {
		if (index > 0) insertNode(() => document.createElement('br'), 'insertLineBreak')
		if (line) insertNode(() => document.createTextNode(line), 'insertText', line)
	})
}

function insertNode(make: () => Node, command: string, value?: string) {
	if (typeof document.execCommand === 'function' && document.execCommand(command, false, value)) {
		return
	}
	const sel = document.getSelection()
	if (!sel || sel.rangeCount === 0) return
	const range = sel.getRangeAt(0)
	range.deleteContents()
	const node = make()
	range.insertNode(node)
	range.setStartAfter(node)
	range.collapse(true)
	sel.removeAllRanges()
	sel.addRange(range)
}

/** Backspace (or Delete) with the caret touching a chip removes the whole chip. */
function removeAdjacentChip(forward: boolean): boolean {
	const sel = document.getSelection()
	if (!sel || sel.rangeCount === 0 || !sel.isCollapsed) return false
	const { anchorNode: node, anchorOffset: offset } = sel
	if (!node) return false
	let neighbour: Node | null | undefined
	if (node.nodeType === 3) {
		const length = (node as Text).data.length
		if (forward ? offset !== length : offset !== 0) return false
		neighbour = forward ? node.nextSibling : node.previousSibling
	} else {
		neighbour = forward ? node.childNodes[offset] : node.childNodes[offset - 1]
	}
	if (!isTagChip(neighbour)) return false
	const parent = neighbour.parentNode
	const index = parent ? Array.prototype.indexOf.call(parent.childNodes, neighbour) : -1
	neighbour.remove()
	if (parent && index >= 0) {
		const range = document.createRange()
		range.setStart(parent, index)
		range.collapse(true)
		sel.removeAllRanges()
		sel.addRange(range)
	}
	return true
}
