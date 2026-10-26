import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { cn } from '@/lib/cn'
import {
	SLASH_CODE_LANGUAGES,
	type SlashItem,
	type SlashMenuState,
	type SlashMenuView,
} from '@maskin/markdown/react/slash-command'
import { Command } from 'cmdk'
import {
	Code,
	Heading2,
	Heading3,
	List,
	ListChecks,
	ListOrdered,
	type LucideIcon,
	Minus,
	Quote,
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { type Root, createRoot } from 'react-dom/client'

// The slash menu for the document editor (tech spec §6, v3 mockup decisions).
// The Tiptap side (items, filter, trigger rules) lives in
// `@maskin/markdown/react/slash-command`; this file is the look: cmdk in a
// Radix popover at the caret, and a bottom sheet at 640px and below.
//
// Focus never leaves the editor. The popover opens without taking focus, the
// editor's key handler drives the selection through `createSlashMenuView`, and
// cmdk only paints and handles pointer picks.

const ITEM_ICONS: Record<string, LucideIcon> = {
	heading: Heading2,
	subheading: Heading3,
	'bulleted-list': List,
	'numbered-list': ListOrdered,
	checklist: ListChecks,
	quote: Quote,
	'code-block': Code,
	divider: Minus,
}

const MOBILE_QUERY = '(max-width: 640px)'

function isMobileViewport(): boolean {
	return typeof window !== 'undefined' && window.matchMedia?.(MOBILE_QUERY).matches === true
}

function IconTile({ icon: Icon }: { icon: LucideIcon }) {
	return (
		<span
			aria-hidden="true"
			className="grid size-[26px] shrink-0 place-items-center rounded-md bg-muted text-muted-foreground"
		>
			<Icon className="size-[14px]" />
		</span>
	)
}

// Header label: 11px semibold muted sentence case. The 8px mono eyebrow is too small on
// touch and would render as BLOCKS.
const HEADER_CLASS = 'px-[9px] pb-[6px] pt-[5px] text-[11px] font-semibold text-muted-foreground'

const ROW_CLASS = cn(
	'flex cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-1.5',
	'data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground',
)

// Keeps a bottom sheet above the on-screen keyboard. Position: fixed follows the
// layout viewport, which a mobile keyboard overlaps, so lift the sheet by the
// part of the layout viewport the visual viewport no longer covers.
function useKeyboardInset(enabled: boolean): number {
	const [inset, setInset] = useState(0)
	useEffect(() => {
		const viewport = window.visualViewport
		if (!enabled || !viewport) return
		const update = () =>
			setInset(Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop))
		update()
		viewport.addEventListener('resize', update)
		viewport.addEventListener('scroll', update)
		return () => {
			viewport.removeEventListener('resize', update)
			viewport.removeEventListener('scroll', update)
		}
	}, [enabled])
	return inset
}

export interface SlashMenuPanelProps {
	items: SlashItem[]
	query: string
	selectedId: string
	step: 'blocks' | 'language'
	selectedLanguageId: string
	getAnchorRect: () => DOMRect | null
	onSelectedChange: (id: string) => void
	onPick: (item: SlashItem) => void
	onSelectedLanguageChange: (id: string) => void
	onPickLanguage: (language: string | null) => void
	onDismiss: () => void
}

function highlightAnnouncement({
	step,
	items,
	selectedId,
	selectedLanguageId,
}: Pick<SlashMenuPanelProps, 'step' | 'items' | 'selectedId' | 'selectedLanguageId'>): string {
	if (step === 'language') {
		const index = SLASH_CODE_LANGUAGES.findIndex((l) => l.id === selectedLanguageId)
		const lang = SLASH_CODE_LANGUAGES[index]
		return lang
			? `${lang.label}, ${index + 1} of ${SLASH_CODE_LANGUAGES.length}`
			: 'Choose a language'
	}
	const index = items.findIndex((i) => i.id === selectedId)
	const item = items[index]
	return item
		? `${item.title}, ${item.description}, ${index + 1} of ${items.length}`
		: 'No matching blocks'
}

export function SlashMenuPanel({
	items,
	query,
	selectedId,
	step,
	selectedLanguageId,
	getAnchorRect,
	onSelectedChange,
	onPick,
	onSelectedLanguageChange,
	onPickLanguage,
	onDismiss,
}: SlashMenuPanelProps) {
	const mobile = isMobileViewport()
	const keyboardInset = useKeyboardInset(mobile)
	const anchor = useMemo(
		() => ({ current: { getBoundingClientRect: () => getAnchorRect() ?? new DOMRect() } }),
		[getAnchorRect],
	)
	// Pointer picks must not pull focus (and the keyboard) out of the editor.
	const keepEditorFocus = (e: React.MouseEvent) => e.preventDefault()

	const body =
		step === 'language' ? (
			<Command
				shouldFilter={false}
				value={selectedLanguageId}
				onValueChange={onSelectedLanguageChange}
				label="Language"
			>
				<div className={HEADER_CLASS}>Language</div>
				<Command.List>
					{SLASH_CODE_LANGUAGES.map((lang) => (
						<Command.Item
							key={lang.id}
							value={lang.id}
							className={cn(ROW_CLASS, 'text-[13px] font-medium')}
							onSelect={() => onPickLanguage(lang.language)}
						>
							{lang.label}
						</Command.Item>
					))}
				</Command.List>
			</Command>
		) : (
			<Command
				shouldFilter={false}
				value={selectedId}
				onValueChange={onSelectedChange}
				label="Blocks"
			>
				<div className={HEADER_CLASS}>{mobile ? 'Insert block' : 'Blocks'}</div>
				<Command.List
					className={cn(
						// Desktop scrolls inside the popover itself, which already caps its height.
						mobile &&
							'max-h-[50dvh] overflow-auto [&_[cmdk-list-sizer]]:grid [&_[cmdk-list-sizer]]:grid-cols-3 [&_[cmdk-list-sizer]]:gap-1',
					)}
				>
					<Command.Empty className="px-2.5 py-3 text-[12.5px] text-muted-foreground">
						<span>No matches for </span>
						<span className="font-semibold text-foreground">{query}</span>
						<span className="mt-0.5 block text-[11px]">Press Esc to keep typing</span>
					</Command.Empty>
					{items.map((item) => (
						<Command.Item
							key={item.id}
							value={item.id}
							className={cn(ROW_CLASS, mobile && 'flex-col items-start gap-1.5 p-2.5')}
							onSelect={() => onPick(item)}
						>
							<IconTile icon={ITEM_ICONS[item.id] ?? Minus} />
							<span className="min-w-0">
								<span className="block text-[13px] font-semibold leading-tight">{item.title}</span>
								<span className="mt-px block text-[11px] leading-tight text-muted-foreground">
									{item.description}
								</span>
							</span>
						</Command.Item>
					))}
				</Command.List>
			</Command>
		)

	// Focus stays in the editor, so announce the highlighted row whenever it moves.
	const announcement = (
		<output className="sr-only">
			{highlightAnnouncement({ step, items, selectedId, selectedLanguageId })}
		</output>
	)

	if (mobile) {
		return (
			<dialog
				open
				aria-label="Insert block"
				onMouseDown={keepEditorFocus}
				style={{ bottom: keyboardInset }}
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
				aria-label="Insert block"
				side="bottom"
				align="start"
				sideOffset={6}
				collisionPadding={8}
				className="w-[262px] rounded-xl p-1.5 shadow-lg"
				onMouseDown={keepEditorFocus}
				onOpenAutoFocus={(e) => e.preventDefault()}
				onCloseAutoFocus={(e) => e.preventDefault()}
				onInteractOutside={(e) => e.preventDefault()}
				// Radix listens for Escape on the document and marks the event handled, so
				// the editor's own key handler never sees it. Close through the same path.
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
 * The view `SlashCommand` drives. Owns the highlighted row and the Code block
 * second step, and paints `SlashMenuPanel` into a detached root; the editor's
 * key handler calls `onKeyDown`, so arrows, Enter, Tab, Escape and Backspace
 * work without focus ever leaving the document.
 */
export function createSlashMenuView(initial: SlashMenuState): SlashMenuView {
	const host = document.createElement('div')
	document.body.appendChild(host)
	const root: Root = createRoot(host)

	let state = initial
	let selectedId = initial.items[0]?.id ?? ''
	let step: 'blocks' | 'language' = 'blocks'
	let languageId: string = SLASH_CODE_LANGUAGES[0]?.id ?? 'plain'

	const getAnchorRect = () => state.clientRect?.() ?? null

	const render = () => {
		root.render(
			<SlashMenuPanel
				items={state.items}
				query={state.query}
				selectedId={selectedId}
				step={step}
				selectedLanguageId={languageId}
				getAnchorRect={getAnchorRect}
				onSelectedChange={(id) => {
					selectedId = id
					render()
				}}
				onPick={pick}
				onSelectedLanguageChange={(id) => {
					languageId = id
					render()
				}}
				onPickLanguage={pickLanguage}
				onDismiss={() => state.dismiss()}
			/>,
		)
	}

	function pick(item: SlashItem) {
		if (item.needsLanguage) {
			step = 'language'
			languageId = SLASH_CODE_LANGUAGES[0]?.id ?? 'plain'
			render()
			return
		}
		state.select(item)
	}

	function pickLanguage(language: string | null) {
		const codeItem = state.items.find((i) => i.needsLanguage)
		if (codeItem) state.select(codeItem, { language })
	}

	function move(delta: 1 | -1) {
		if (step === 'language') {
			const index = SLASH_CODE_LANGUAGES.findIndex((l) => l.id === languageId)
			const next = (index + delta + SLASH_CODE_LANGUAGES.length) % SLASH_CODE_LANGUAGES.length
			languageId = SLASH_CODE_LANGUAGES[next]?.id ?? languageId
		} else if (state.items.length > 0) {
			const index = state.items.findIndex((i) => i.id === selectedId)
			const next = (index + delta + state.items.length) % state.items.length
			selectedId = state.items[next]?.id ?? selectedId
		}
		render()
	}

	render()

	return {
		update(next) {
			const queryChanged = next.query !== state.query
			state = next
			// A typed character while choosing a language changes the query: go back.
			if (queryChanged) step = 'blocks'
			if (!state.items.some((i) => i.id === selectedId)) selectedId = state.items[0]?.id ?? ''
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
					if (step === 'language') {
						const lang = SLASH_CODE_LANGUAGES.find((l) => l.id === languageId)
						pickLanguage(lang?.language ?? null)
						return true
					}
					const item = state.items.find((i) => i.id === selectedId)
					if (!item) return false
					pick(item)
					return true
				}
				case 'Escape':
					state.dismiss()
					return true
				case 'Backspace':
					if (step === 'language') {
						step = 'blocks'
						render()
						return true
					}
					if (state.query === '') {
						// Closes the menu and leaves the "/" where it is.
						state.dismiss()
						return true
					}
					return false
				default:
					// Typing while choosing a language would rewrite the query behind it.
					return step === 'language' && event.key.length === 1
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
