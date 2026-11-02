import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/cn'
import { Search, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

/**
 * The list pages' own search (Items, Flows, Agents), mounted through
 * `PageHeader` `actions` so it sits in the title row beside Display.
 *
 * From `xl` up it is the field itself. Below that there is no room for a field
 * next to the workspace search and the New button (at 768 and 1024 the sidebar
 * leaves the title row about 490 and 710px), so it is a search icon; a tap opens
 * an inline field that takes over the title row (not a popover), with a close
 * control. The workspace search and New stay reachable once it closes.
 *
 * `debounceMs` holds typing back from `onChange` for pages whose search is a
 * server filter (Items), while the field itself stays responsive. A change of
 * `value` from outside (a removed filter pill) replaces the text.
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
	const [row, setRow] = useState<{ left: number; top: number; width: number; height: number }>()
	const sentRef = useRef(value)
	const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
	const mobileInputRef = useRef<HTMLInputElement>(null)

	useEffect(() => {
		if (value === sentRef.current) return
		sentRef.current = value
		setText(value)
	}, [value])

	useEffect(() => () => clearTimeout(timerRef.current), [])

	useEffect(() => {
		if (open) mobileInputRef.current?.focus()
	}, [open])

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
					if (e.key === 'Escape') setOpen(false)
				}}
				placeholder={label}
				aria-label={label}
				className="h-8 rounded-full border-transparent bg-muted pl-9"
			/>
		</div>
	)

	return (
		<>
			<div className={cn('hidden w-56 shrink-0 xl:flex', className)}>{field()}</div>
			<Button
				type="button"
				variant="ghost"
				size="icon"
				aria-label={label}
				title={label}
				onClick={(e) => {
					// The row to take over: the shared header this button sits in.
					const header = e.currentTarget.closest('header')?.getBoundingClientRect()
					if (header) {
						setRow({
							left: header.left,
							top: header.top,
							width: header.width,
							height: header.height,
						})
					}
					setOpen(true)
				}}
				className={cn(
					'relative size-[30px] shrink-0 rounded-lg text-muted-foreground xl:hidden',
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
						onClick={() => setOpen(false)}
						className="size-[30px] shrink-0 rounded-lg text-muted-foreground"
					>
						<X aria-hidden size={15} />
					</Button>
				</div>
			)}
		</>
	)
}
