import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { cn } from '@/lib/cn'
import type {
	EmojiItem,
	EmojiMenuState,
	EmojiMenuView,
} from '@maskin/markdown/react/emoji-suggestion'
import { Command } from 'cmdk'
import { useMemo } from 'react'
import { type Root, createRoot } from 'react-dom/client'

// The list that opens in the chat box when the person types a colon and two letters (":smi").
// The Tiptap side (emoji data, filter, trigger rules) lives in
// `@maskin/markdown/react/emoji-suggestion`; this file is the look: a popover at the caret that
// flips above or below the line and stays inside the screen, with taller rows at phone width.
//
// Focus never leaves the box. The editor's key handler drives the highlighted row through
// `createEmojiMenuView`; the rows only paint and take pointer picks.

const ROW_CLASS = cn(
	'flex cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-1.5 text-[13px]',
	'data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground',
)

export interface EmojiMenuPanelProps {
	items: EmojiItem[]
	selectedShortcode: string
	getAnchorRect: () => DOMRect | null
	onSelectedChange: (shortcode: string) => void
	onPick: (item: EmojiItem) => void
	onDismiss: () => void
}

export function EmojiMenuPanel({
	items,
	selectedShortcode,
	getAnchorRect,
	onSelectedChange,
	onPick,
	onDismiss,
}: EmojiMenuPanelProps) {
	const anchor = useMemo(
		() => ({ current: { getBoundingClientRect: () => getAnchorRect() ?? new DOMRect() } }),
		[getAnchorRect],
	)
	// Pointer picks must not pull focus (and the keyboard) out of the box.
	const keepEditorFocus = (e: React.MouseEvent) => e.preventDefault()
	const selected = items.find((i) => i.shortcode === selectedShortcode)

	// Focus stays in the box, so announce the highlighted row whenever it moves.
	const announcement = (
		<output className="sr-only">
			{selected
				? `${selected.shortcode.replaceAll('_', ' ')}, ${items.indexOf(selected) + 1} of ${items.length}`
				: ''}
		</output>
	)

	const list = (
		<Command
			shouldFilter={false}
			value={selectedShortcode}
			onValueChange={onSelectedChange}
			label="Emoji"
		>
			<Command.List label="Emoji">
				{items.map((item) => (
					<Command.Item
						key={item.shortcode}
						value={item.shortcode}
						className={cn(ROW_CLASS, 'max-md:min-h-11')}
						onSelect={() => onPick(item)}
					>
						<span aria-hidden="true" className="w-6 shrink-0 text-center text-lg leading-none">
							{item.emoji}
						</span>
						<span className="min-w-0 truncate font-medium">:{item.shortcode}:</span>
					</Command.Item>
				))}
			</Command.List>
		</Command>
	)

	return (
		<Popover open>
			<PopoverAnchor virtualRef={anchor} />
			<PopoverContent
				side="top"
				align="start"
				sideOffset={6}
				collisionPadding={8}
				className="w-64 max-w-[var(--radix-popover-content-available-width)] rounded-xl p-1.5 shadow-lg"
				onMouseDown={keepEditorFocus}
				onOpenAutoFocus={(e) => e.preventDefault()}
				onCloseAutoFocus={(e) => e.preventDefault()}
				onInteractOutside={(e) => e.preventDefault()}
				// Radix listens for Escape on the document and marks the event handled, so the
				// box's own key handler never sees it. Close through the same path.
				onEscapeKeyDown={(e) => {
					e.preventDefault()
					onDismiss()
				}}
			>
				{announcement}
				{list}
			</PopoverContent>
		</Popover>
	)
}

/**
 * The view `EmojiSuggestion` drives. Owns the highlighted row and paints `EmojiMenuPanel` into a
 * detached root; the box's key handler calls `onKeyDown`, so arrows, Enter, Tab and Escape work
 * without focus leaving the message.
 */
export function createEmojiMenuView(initial: EmojiMenuState): EmojiMenuView {
	const host = document.createElement('div')
	document.body.appendChild(host)
	const root: Root = createRoot(host)

	let state = initial
	let selected = initial.items[0]?.shortcode ?? ''

	const getAnchorRect = () => state.clientRect?.() ?? null

	const render = () => {
		root.render(
			<EmojiMenuPanel
				items={state.items}
				selectedShortcode={selected}
				getAnchorRect={getAnchorRect}
				onSelectedChange={(shortcode) => {
					selected = shortcode
					render()
				}}
				onPick={(item) => state.select(item)}
				onDismiss={() => state.dismiss()}
			/>,
		)
	}

	function move(delta: 1 | -1) {
		if (state.items.length === 0) return
		const index = state.items.findIndex((i) => i.shortcode === selected)
		const next = (index + delta + state.items.length) % state.items.length
		selected = state.items[next]?.shortcode ?? selected
		render()
	}

	render()

	return {
		update(next) {
			state = next
			// A new query is a new list: the best match is the top row again.
			selected = state.items[0]?.shortcode ?? ''
			render()
		},
		onKeyDown(event) {
			if (event.metaKey || event.ctrlKey || event.altKey) return false
			switch (event.key) {
				case 'ArrowDown':
					move(1)
					return true
				case 'ArrowUp':
					move(-1)
					return true
				case 'Enter':
				case 'Tab': {
					if (event.shiftKey) return false
					const item = state.items.find((i) => i.shortcode === selected)
					if (!item) return false
					state.select(item)
					return true
				}
				case 'Escape':
					state.dismiss()
					return true
				default:
					return false
			}
		},
		destroy() {
			// Unmount after the current update so React is not torn down mid-render.
			queueMicrotask(() => {
				root.unmount()
				host.remove()
			})
		},
	}
}
