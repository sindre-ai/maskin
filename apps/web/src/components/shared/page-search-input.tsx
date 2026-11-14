import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/cn'
import { focusField, usePageSearchShortcut } from '@/lib/page-search-shortcut'
import { Search, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

/**
 * The list pages' own search (Items, Flows, Agents), mounted through
 * `PageHeader` `actions` so it sits in the title row beside Display.
 *
 * Always a 32px soft circle with a search glyph (the design's collapsed search).
 * From `xl` up a click or focus grows it in place into the field, and it folds
 * back when it loses focus empty. Below that there is no room for a field next to
 * the New button (at 768 and 1024 the sidebar leaves the title row about 490 and
 * 710px), so a tap opens an inline field that takes over the title row (not a
 * popover), with a close control. Cmd/Ctrl+F reaches the same field (it registers
 * with `usePageSearchShortcut`), opening it first where it is collapsed.
 *
 * `debounceMs` holds typing back from `onChange` for pages whose search is a
 * server filter (Items), while the field itself stays responsive. A change of
 * `value` from outside (a removed filter pill) replaces the text. Esc clears the text and
 * leaves the field, so the list is not left filtered.
 */
export function PageSearchInput({
	value,
	onChange,
	label,
	debounceMs = 0,
	className,
}: {
	value: string
	onChange: (value: string) => void
	/** Accessible name and placeholder, e.g. "Search agents". */
	label: string
	debounceMs?: number
	className?: string
}) {
	const [text, setText] = useState(value)
	const [open, setOpen] = useState(false)
	const [wideOpen, setWideOpen] = useState(false)
	const [row, setRow] = useState<{ left: number; top: number; width: number; height: number }>()
	const sentRef = useRef(value)
	const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
	const mobileInputRef = useRef<HTMLInputElement>(null)
	const wideInputRef = useRef<HTMLInputElement>(null)
	const iconRef = useRef<HTMLButtonElement>(null)

	useEffect(() => {
		if (value === sentRef.current) return
		sentRef.current = value
		setText(value)
	}, [value])

	useEffect(() => () => clearTimeout(timerRef.current), [])

	useEffect(() => {
		if (open) mobileInputRef.current?.focus()
	}, [open])

	// The row to take over: the shared header the icon button sits in.
	function openCollapsed(header: Element | null | undefined) {
		const box = header?.getBoundingClientRect()
		if (box) setRow({ left: box.left, top: box.top, width: box.width, height: box.height })
		setOpen(true)
	}

	// Closing the takeover removes the focused input, which would drop the caret to
	// the page body. Hand focus back to the icon button that opened it.
	function closeNarrow() {
		setOpen(false)
		iconRef.current?.focus()
	}

	usePageSearchShortcut(() => {
		// Wide: the field itself is on screen. Narrow: open the inline field (or, if it
		// is already open, put the caret back in it).
		if (focusField(wideInputRef.current)) return true
		if (open) return focusField(mobileInputRef.current)
		if (!iconRef.current) return false
		openCollapsed(iconRef.current.closest('header'))
		return true
	})

	function handleChange(next: string) {
		setText(next)
		clearTimeout(timerRef.current)
		if (debounceMs <= 0) {
			sentRef.current = next
			onChange(next)
			return
		}
		timerRef.current = setTimeout(() => {
			sentRef.current = next
			onChange(next)
		}, debounceMs)
	}

	const field = (ref?: React.Ref<HTMLInputElement>) => (
		<div className="relative min-w-0 flex-1">
			<Search
				size={14}
				aria-hidden
				className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted-foreground"
			/>
			<Input
				ref={ref}
				type="search"
				value={text}
				onChange={(e) => handleChange(e.target.value)}
				onKeyDown={(e) => {
					if (e.key === 'Escape') {
						handleChange('')
						closeNarrow()
					}
				}}
				placeholder={label}
				aria-label={label}
				className="h-8 rounded-full border-transparent bg-muted pl-9"
			/>
		</div>
	)

	return (
		<>
			{/* The wide field. The input keeps its full width so it stays focusable while
			    collapsed; the 32px clip box is what animates. */}
			<div
				className={cn(
					'relative hidden h-8 shrink-0 cursor-text overflow-hidden rounded-full bg-muted transition-[width] duration-300 ease-out xl:block',
					wideOpen || text ? 'w-56' : 'w-8 cursor-pointer',
					className,
				)}
			>
				<Search
					size={15}
					aria-hidden
					className="pointer-events-none absolute top-1/2 left-2 -translate-y-1/2 text-muted-foreground"
				/>
				<Input
					ref={wideInputRef}
					type="search"
					value={text}
					onChange={(e) => handleChange(e.target.value)}
					onFocus={() => setWideOpen(true)}
					onBlur={() => setWideOpen(false)}
					onKeyDown={(e) => {
						if (e.key === 'Escape') {
							handleChange('')
							e.currentTarget.blur()
						}
					}}
					placeholder={label}
					aria-label={label}
					className="h-8 w-56 rounded-full border-transparent bg-transparent pl-9"
				/>
			</div>
			<Button
				type="button"
				variant="ghost"
				size="icon"
				aria-label={label}
				title={label}
				ref={iconRef}
				onClick={(e) => openCollapsed(e.currentTarget.closest('header'))}
				className={cn(
					'touch-hit relative size-8 shrink-0 rounded-full bg-muted text-muted-foreground hover:bg-muted xl:hidden',
					text && 'text-foreground',
				)}
			>
				<Search aria-hidden size={15} />
				{text && (
					<span aria-hidden className="absolute top-1 right-1 size-1.5 rounded-full bg-primary" />
				)}
			</Button>
			{open && (
				// Takes over the title row: laid exactly over the shared header (its
				// measured box, so it clears the sidebar at md and lg), nothing under
				// it moves while it is open. The box is measured, hence the inline style.
				<div
					className="fixed z-40 flex items-center gap-2 bg-background px-4 md:px-8 lg:px-7 xl:hidden"
					style={row}
				>
					{field(mobileInputRef)}
					<Button
						type="button"
						variant="ghost"
						size="icon"
						aria-label="Close search"
						onClick={closeNarrow}
						className="touch-hit relative size-[30px] shrink-0 rounded-lg text-muted-foreground"
					>
						<X aria-hidden size={15} />
					</Button>
				</div>
			)}
		</>
	)
}
