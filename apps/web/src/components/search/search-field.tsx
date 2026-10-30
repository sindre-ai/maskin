import type { ParticipantMenuState } from '@/hooks/use-participant-menu'
import { cn } from '@/lib/cn'
import type { Pill, SearchParts } from '@/lib/search/parts'
import type { Suggestion } from '@/lib/search/pillify'
import { type Vocabulary, pillLabel } from '@/lib/search/vocabulary'
import { Search, X } from 'lucide-react'
import { type KeyboardEvent, type RefObject, useRef } from 'react'

interface SearchFieldProps {
	/** The page field is 50px tall with 30px pills; the launcher's is a 30px input with 26px pills. */
	variant?: 'page' | 'palette'
	parts: SearchParts
	vocab: Vocabulary
	suggestion: Suggestion | null
	inputRef: RefObject<HTMLInputElement | null>
	/** Id of the results listbox the field controls. */
	listboxId: string
	/** Id of the highlighted option, if any. Focus stays in the field. */
	activeOptionId: string | undefined
	listboxOpen: boolean
	/** The @ menu. Absent when the participant filter is off. While it is open it takes the arrows, Enter, Tab and Esc. */
	menu?: ParticipantMenuState
	onTextChange: (text: string, composing: boolean) => void
	onAcceptSuggestion: (via: 'tab' | 'click') => void
	onDismissSuggestion: () => void
	onBackspaceToWord: () => void
	onRemovePill: (index: number) => void
	onClearText: () => void
	onMoveActive: (delta: 1 | -1) => void
	onOpenActive: () => void
	/** Cmd or Ctrl with Enter. Without it the key opens the highlighted result like a plain Enter. */
	onModEnter?: () => void
	/** Escape with no suggestion showing. The page decides: clear the words, then go back. */
	onEscape: () => void
}

// One field: a leading group of pills (real buttons) followed by one text input.
// A typed type or status word becomes a pill only when the person presses Tab or
// clicks the suggestion; Backspace at the start of the input turns the last pill
// back into its word. Focus never leaves the input while arrowing through results.
export function SearchField({
	variant = 'page',
	parts,
	vocab,
	suggestion,
	inputRef,
	listboxId,
	activeOptionId,
	listboxOpen,
	menu,
	onTextChange,
	onAcceptSuggestion,
	onDismissSuggestion,
	onBackspaceToWord,
	onRemovePill,
	onClearText,
	onMoveActive,
	onOpenActive,
	onModEnter,
	onEscape,
}: SearchFieldProps) {
	const composing = useRef(false)
	const palette = variant === 'palette'
	const suggestionLabel = suggestion ? pillLabel(vocab, suggestion.kind, suggestion.value) : ''

	const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
		// Keys that belong to an input method (IME) are not ours.
		if (composing.current || e.nativeEvent.isComposing) return
		const plain = !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey
		if (menu?.open) {
			if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
				e.preventDefault()
				menu.move(e.key === 'ArrowDown' ? 1 : -1)
				return
			}
			if ((e.key === 'Enter' || e.key === 'Tab') && plain) {
				e.preventDefault()
				menu.pickActive(e.key === 'Enter' ? 'keyboard' : 'tab')
				return
			}
			if (e.key === 'Escape') {
				e.preventDefault()
				menu.dismiss()
				return
			}
		}
		switch (e.key) {
			case 'Tab':
				// Tab accepts only a suggestion that is showing; otherwise focus moves on.
				if (plain && suggestion) {
					e.preventDefault()
					onAcceptSuggestion('tab')
				}
				return
			case 'Backspace': {
				const { selectionStart, selectionEnd } = e.currentTarget
				if (selectionStart === 0 && selectionEnd === 0 && parts.pills.length > 0) {
					e.preventDefault()
					onBackspaceToWord()
				}
				return
			}
			case 'Escape':
				e.preventDefault()
				if (suggestion) onDismissSuggestion()
				else onEscape()
				return
			case 'ArrowDown':
				e.preventDefault()
				onMoveActive(1)
				return
			case 'ArrowUp':
				e.preventDefault()
				onMoveActive(-1)
				return
			case 'Enter':
				// Enter opens the highlighted result. It never turns a word into a pill.
				e.preventDefault()
				if ((e.metaKey || e.ctrlKey) && onModEnter) onModEnter()
				else onOpenActive()
				return
		}
	}

	return (
		<div
			className={cn(
				'flex min-w-0 flex-1 items-center gap-1.5',
				palette
					? 'min-h-12 px-3.5 py-1'
					: 'min-h-[50px] rounded-lg border border-input bg-background px-3 py-1.5 transition-colors focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/30',
			)}
		>
			{/* Pills and the input wrap onto more lines on a narrow screen, so none is hidden; the clear button stays at the end of the first line. */}
			<div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-1.5 gap-y-1">
				<Search aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />

				{parts.pills.map((pill, index) => (
					<PillButton
						key={`${pill.kind}:${pill.value}`}
						pill={pill}
						size={palette ? 26 : 30}
						label={pillLabel(vocab, pill.kind, pill.value)}
						onRemove={() => onRemovePill(index)}
					/>
				))}

				<input
					ref={inputRef}
					type="text"
					role="combobox"
					aria-label={palette ? 'Search or run a command' : 'Search'}
					data-search-field={variant}
					aria-autocomplete="list"
					aria-expanded={menu?.open || listboxOpen}
					aria-controls={menu?.open ? menu.listboxId : listboxId}
					aria-activedescendant={menu?.open ? menu.activeId : activeOptionId}
					autoComplete="off"
					spellCheck={false}
					value={parts.text}
					placeholder={
						parts.pills.length > 0
							? 'Add words…'
							: palette
								? 'Run a command or jump to…'
								: 'Search everything…'
					}
					onChange={(e) => onTextChange(e.target.value, composing.current)}
					onCompositionStart={() => {
						composing.current = true
					}}
					onCompositionEnd={(e) => {
						composing.current = false
						onTextChange(e.currentTarget.value, false)
					}}
					onKeyDown={onKeyDown}
					className={cn(
						'min-w-[8ch] flex-1 bg-transparent text-foreground outline-none placeholder:text-muted-foreground',
						palette ? 'h-[30px] text-[13.5px]' : 'h-[34px] text-[14px]',
					)}
				/>

				{suggestion ? (
					<button
						type="button"
						onClick={() => onAcceptSuggestion('click')}
						className={cn(
							'inline-flex shrink-0 items-center gap-1.5 rounded-md border border-dashed border-border-strong px-2.5 text-[12px] font-medium text-muted-foreground transition-colors hover:border-foreground hover:text-foreground max-[1024.02px]:min-h-11',
							palette ? 'h-[26px]' : 'h-[30px]',
						)}
					>
						Filter by {suggestionLabel}
						{/* There is no Tab key on a phone: the label is the tap target there. */}
						<kbd className="hidden rounded border border-border bg-secondary px-1 font-mono text-[10px] md:inline-block">
							Tab
						</kbd>
					</button>
				) : null}
			</div>

			{parts.text ? (
				<button
					type="button"
					aria-label="Clear search"
					onClick={onClearText}
					className="grid size-[30px] shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground max-[1024.02px]:size-11"
				>
					<X aria-hidden="true" className="size-4" />
				</button>
			) : null}

			{/* Said once when a suggestion appears, so a screen reader hears the hint. */}
			<output className="sr-only">
				{suggestion ? `Press Tab to filter by ${suggestionLabel}` : ''}
			</output>
		</div>
	)
}

function PillButton({
	pill,
	label,
	size,
	onRemove,
}: {
	pill: Pill
	label: string
	/** Height of the pill in px: 30 on the page, 26 in the launcher. */
	size: 26 | 30
	onRemove: () => void
}) {
	const typed = pill.word ? `, typed as ${pill.word}` : ''
	return (
		<span
			className={cn(
				'inline-flex shrink-0 items-center gap-0.5 rounded-md bg-muted pl-2.5 text-[13px] font-semibold text-foreground',
				size === 26 ? 'h-[26px]' : 'h-[30px]',
				pill.kind === 'status' && 'bg-secondary',
				pill.kind === 'participant' && 'bg-accent',
			)}
		>
			{label}
			<button
				type="button"
				aria-label={`Remove filter: ${label}${typed}`}
				onClick={onRemove}
				className={cn(
					'grid place-items-center rounded-md text-muted-foreground transition-colors hover:text-foreground max-[1024.02px]:size-11',
					size === 26 ? 'size-[26px]' : 'size-[30px]',
				)}
			>
				<X aria-hidden="true" className="size-3.5" />
			</button>
		</span>
	)
}
