import {
	HEADER_CLASS,
	ROW_CLASS,
	isMobileViewport,
	useKeyboardInset,
} from '@/components/shared/slash-menu'
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

// The emoji list for the chat message box. The Tiptap side (data, filter, trigger rules) lives in
// `@maskin/markdown/react/emoji-suggestion`; this file is the look, the same as the slash menu:
// cmdk in a Radix popover at the caret, and a bottom sheet with a grid at 640px and below.
// Focus never leaves the box: the key handler drives the selection through `createEmojiMenuView`.

export interface EmojiMenuPanelProps {
	items: EmojiItem[]
	query: string
	selectedCode: string
	getAnchorRect: () => DOMRect | null
	onSelectedChange: (shortcode: string) => void
	onPick: (item: EmojiItem) => void
	onDismiss: () => void
}

export function EmojiMenuPanel({
	items,
	query,
	selectedCode,
	getAnchorRect,
	onSelectedChange,
	onPick,
	onDismiss,
}: EmojiMenuPanelProps) {
	const mobile = isMobileViewport()
	const keyboardInset = useKeyboardInset(mobile)
	const anchor = useMemo(
		() => ({ current: { getBoundingClientRect: () => getAnchorRect() ?? new DOMRect() } }),
		[getAnchorRect],
	)
	// Pointer picks must not pull focus (and the keyboard) out of the box.
	const keepEditorFocus = (e: React.MouseEvent) => e.preventDefault()

	const selected = items.find((i) => i.shortcode === selectedCode)
	const body = (
		<Command
			shouldFilter={false}
			value={selectedCode}
			onValueChange={onSelectedChange}
			label="Emoji"
		>
			<div className={HEADER_CLASS}>
				Emoji matching <span className="text-foreground">:{query}</span>
			</div>
			<Command.List
				className={cn(
					mobile &&
						'max-h-[40dvh] overflow-auto [&_[cmdk-list-sizer]]:grid [&_[cmdk-list-sizer]]:grid-cols-4 [&_[cmdk-list-sizer]]:gap-1',
				)}
			>
				{items.map((item) => (
					<Command.Item
						key={item.shortcode}
						value={item.shortcode}
						aria-label={item.shortcode.replaceAll('_', ' ')}
						className={cn(
							ROW_CLASS,
							'gap-2.5 text-[13px]',
							mobile && 'flex-col justify-center gap-1 p-2 text-center',
						)}
						onSelect={() => onPick(item)}
					>
						<span aria-hidden className={cn('text-xl leading-none', mobile && 'text-2xl')}>
							{item.emoji}
						</span>
						<span
							className={cn(
								'min-w-0 truncate',
								mobile ? 'max-w-full text-[10px] text-muted-foreground' : 'font-medium',
							)}
						>
							{mobile ? item.shortcode : `:${item.shortcode}:`}
						</span>
					</Command.Item>
				))}
			</Command.List>
		</Command>
	)

	// Focus stays in the box, so announce the highlighted row whenever it moves.
	const announcement = (
		<output className="sr-only">
			{selected
				? `${selected.shortcode.replaceAll('_', ' ')}, ${items.indexOf(selected) + 1} of ${items.length}`
				: 'No emoji selected'}
		</output>
	)

	if (mobile) {
		// The message box sits at the bottom, so the sheet goes above the line being typed
		// instead of over it, and never lower than the on-screen keyboard.
		const caret = getAnchorRect()
		const bottom = caret
			? Math.max(keyboardInset, window.innerHeight - caret.top + 8)
			: keyboardInset
		return (
			<dialog
				open
				aria-label="Insert emoji"
				onMouseDown={keepEditorFocus}
				style={{ bottom }}
				className="fixed inset-x-0 z-50 m-0 w-auto rounded-t-2xl border-t border-border bg-popover p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] text-popover-foreground shadow-xl"
			>
				{announcement}
				{body}
			</dialog>
		)
	}

	return (
		<Popover open>
			<PopoverAnchor virtualRef={anchor} />
			<PopoverContent
				aria-label="Insert emoji"
				side="top"
				align="start"
				sideOffset={6}
				collisionPadding={8}
				className="w-[262px] rounded-xl p-1.5 shadow-lg"
				onMouseDown={keepEditorFocus}
				onOpenAutoFocus={(e) => e.preventDefault()}
				onCloseAutoFocus={(e) => e.preventDefault()}
				onInteractOutside={(e) => e.preventDefault()}
				// Radix listens for Escape on the document and marks the event handled, so the box's
				// own key handler never sees it. Close through the same path.
				onEscapeKeyDown={(e) => {
					e.preventDefault()
					onDismiss()
				}}
			>
				{announcement}
				{body}
			</PopoverContent>
		</Popover>
	)
}

/**
 * The view `EmojiSuggestion` drives. Owns the highlighted row and paints `EmojiMenuPanel` into a
 * detached root; the box's key handler calls `onKeyDown`, so arrows, Enter, Tab and Escape work
 * without focus ever leaving the message.
 */
export function createEmojiMenuView(initial: EmojiMenuState): EmojiMenuView {
	const host = document.createElement('div')
	document.body.appendChild(host)
	const root: Root = createRoot(host)

	let state = initial
	let selectedCode = initial.items[0]?.shortcode ?? ''

	const getAnchorRect = () => state.clientRect?.() ?? null

	const render = () => {
		root.render(
			<EmojiMenuPanel
				items={state.items}
				query={state.query}
				selectedCode={selectedCode}
				getAnchorRect={getAnchorRect}
				onSelectedChange={(code) => {
					selectedCode = code
					render()
				}}
				onPick={(item) => state.select(item)}
				onDismiss={() => state.dismiss()}
			/>,
		)
	}

	function move(delta: 1 | -1) {
		if (state.items.length === 0) return
		const index = state.items.findIndex((i) => i.shortcode === selectedCode)
		const next = (index + delta + state.items.length) % state.items.length
		selectedCode = state.items[next]?.shortcode ?? selectedCode
		render()
	}

	render()

	return {
		update(next) {
			state = next
			if (!state.items.some((i) => i.shortcode === selectedCode)) {
				selectedCode = state.items[0]?.shortcode ?? ''
			}
			render()
		},
		onKeyDown(event) {
			if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return false
			switch (event.key) {
				case 'ArrowDown':
					move(1)
					return true
				case 'ArrowUp':
					move(-1)
					return true
				case 'Enter':
				case 'Tab': {
					const item = state.items.find((i) => i.shortcode === selectedCode)
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
