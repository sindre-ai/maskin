import { cn } from '@/lib/cn'
import { Extension, type Range, ReactRenderer } from '@tiptap/react'
import Suggestion, { type SuggestionKeyDownProps, type SuggestionProps } from '@tiptap/suggestion'
import {
	CheckSquare,
	Code2,
	Heading1,
	Heading2,
	Heading3,
	List,
	ListOrdered,
	type LucideIcon,
	Quote,
	Table as TableIcon,
} from 'lucide-react'
import {
	type ComponentProps,
	type ForwardedRef,
	forwardRef,
	useEffect,
	useImperativeHandle,
	useRef,
	useState,
} from 'react'

// Slash-command picker for the TipTap editor. Wires @tiptap/suggestion (MIT)
// to a small React menu so `/` at the start of a block surfaces the block
// affordances the bet's AC bullet enumerates — heading (h1/h2/h3), bullet
// list, ordered list, task list, table, code block, quote. Bet exit
// criterion holds: no Pro-tier extension is pulled in.

interface SlashItem {
	title: string
	description: string
	keywords: string[]
	icon: LucideIcon
	run: (args: { editor: SuggestionProps<SlashItem>['editor']; range: Range }) => void
}

const SLASH_ITEMS: SlashItem[] = [
	{
		title: 'Heading 1',
		description: 'Large section title',
		keywords: ['h1', 'title'],
		icon: Heading1,
		run: ({ editor, range }) =>
			editor.chain().focus().deleteRange(range).setNode('heading', { level: 1 }).run(),
	},
	{
		title: 'Heading 2',
		description: 'Medium section heading',
		keywords: ['h2', 'subtitle'],
		icon: Heading2,
		run: ({ editor, range }) =>
			editor.chain().focus().deleteRange(range).setNode('heading', { level: 2 }).run(),
	},
	{
		title: 'Heading 3',
		description: 'Small subheading',
		keywords: ['h3'],
		icon: Heading3,
		run: ({ editor, range }) =>
			editor.chain().focus().deleteRange(range).setNode('heading', { level: 3 }).run(),
	},
	{
		title: 'Bullet list',
		description: 'Unordered list',
		keywords: ['ul', 'bullet', 'unordered'],
		icon: List,
		run: ({ editor, range }) => editor.chain().focus().deleteRange(range).toggleBulletList().run(),
	},
	{
		title: 'Ordered list',
		description: 'Numbered list',
		keywords: ['ol', 'ordered', 'numbered'],
		icon: ListOrdered,
		run: ({ editor, range }) => editor.chain().focus().deleteRange(range).toggleOrderedList().run(),
	},
	{
		title: 'Task list',
		description: 'Checklist of to-dos',
		keywords: ['todo', 'checkbox', 'checklist'],
		icon: CheckSquare,
		run: ({ editor, range }) => editor.chain().focus().deleteRange(range).toggleTaskList().run(),
	},
	{
		title: 'Table',
		description: '3×3 GFM table',
		keywords: ['grid'],
		icon: TableIcon,
		run: ({ editor, range }) =>
			editor
				.chain()
				.focus()
				.deleteRange(range)
				.insertTable({ rows: 3, cols: 3, withHeaderRow: true })
				.run(),
	},
	{
		title: 'Code block',
		description: 'Fenced code with syntax highlighting',
		keywords: ['pre', 'code', 'snippet'],
		icon: Code2,
		run: ({ editor, range }) => editor.chain().focus().deleteRange(range).toggleCodeBlock().run(),
	},
	{
		title: 'Quote',
		description: 'Blockquote for callouts',
		keywords: ['blockquote'],
		icon: Quote,
		run: ({ editor, range }) => editor.chain().focus().deleteRange(range).toggleBlockquote().run(),
	},
]

function filterItems(query: string): SlashItem[] {
	const q = query.trim().toLowerCase()
	if (!q) return SLASH_ITEMS
	return SLASH_ITEMS.filter((item) => {
		if (item.title.toLowerCase().includes(q)) return true
		return item.keywords.some((k) => k.includes(q))
	})
}

export interface SlashCommandMenuHandle {
	onKeyDown: (event: KeyboardEvent) => boolean
}

interface SlashCommandMenuProps {
	items: SlashItem[]
	command: (item: SlashItem) => void
}

export const SlashCommandMenu = forwardRef(function SlashCommandMenu(
	{ items, command }: SlashCommandMenuProps,
	ref: ForwardedRef<SlashCommandMenuHandle>,
) {
	const [selectedIndex, setSelectedIndex] = useState(0)
	// Mirror of `selectedIndex` for the imperative handle. `onKeyDown` is
	// called synchronously by ProseMirror between renders — reading React
	// state directly there returns the stale value from the last render.
	const selectedRef = useRef(0)
	const setSelected = (next: number) => {
		selectedRef.current = next
		setSelectedIndex(next)
	}

	// Clamp selection when the filtered list shrinks below the current index.
	useEffect(() => {
		if (selectedIndex > items.length - 1) {
			selectedRef.current = 0
			setSelectedIndex(0)
		}
	}, [items.length, selectedIndex])

	useImperativeHandle(ref, () => ({
		onKeyDown: (event) => {
			if (event.key === 'ArrowDown') {
				if (items.length === 0) return true
				setSelected((selectedRef.current + 1) % items.length)
				return true
			}
			if (event.key === 'ArrowUp') {
				if (items.length === 0) return true
				setSelected((selectedRef.current - 1 + items.length) % items.length)
				return true
			}
			if (event.key === 'Enter') {
				const item = items[selectedRef.current]
				if (item) command(item)
				return true
			}
			return false
		},
	}))

	if (items.length === 0) {
		return (
			<div
				role="menu"
				aria-label="Slash commands"
				data-testid="slash-command-menu"
				className="w-64 rounded-md border border-border bg-popover p-2 text-sm text-muted-foreground shadow-md"
			>
				No matches
			</div>
		)
	}

	return (
		<div
			role="menu"
			aria-label="Slash commands"
			data-testid="slash-command-menu"
			className="w-64 max-h-72 overflow-y-auto rounded-md border border-border bg-popover p-1 shadow-md"
		>
			{items.map((item, index) => (
				<SlashCommandRow
					key={item.title}
					item={item}
					active={index === selectedIndex}
					onSelect={() => command(item)}
					onHover={() => setSelectedIndex(index)}
				/>
			))}
		</div>
	)
})

function SlashCommandRow({
	item,
	active,
	onSelect,
	onHover,
}: {
	item: SlashItem
	active: boolean
	onSelect: () => void
	onHover: () => void
}) {
	const Icon = item.icon
	return (
		<button
			type="button"
			role="menuitem"
			aria-current={active ? 'true' : undefined}
			data-active={active ? 'true' : undefined}
			className={cn(
				'flex w-full items-start gap-2 rounded px-2 py-1.5 text-left transition-colors',
				'hover:bg-accent hover:text-accent-foreground',
				active && 'bg-accent text-accent-foreground',
			)}
			// onMouseDown so the click fires before the editor blurs and the
			// suggestion popup unmounts.
			onMouseDown={(e) => {
				e.preventDefault()
				onSelect()
			}}
			onMouseEnter={onHover}
		>
			<span
				className={cn(
					'flex h-8 w-8 shrink-0 items-center justify-center rounded border border-border bg-background',
					'[&_svg]:size-4',
				)}
			>
				<Icon />
			</span>
			<span className="flex flex-col">
				<span className="text-sm font-medium text-foreground">{item.title}</span>
				<span className="text-xs text-muted-foreground">{item.description}</span>
			</span>
		</button>
	)
}

// Rendered menu props are managed by ReactRenderer.updateProps — pull the type
// off the component so `updateProps` stays type-checked.
type MenuRendererProps = ComponentProps<typeof SlashCommandMenu>

export const SlashCommand = Extension.create({
	name: 'slashCommand',

	addProseMirrorPlugins() {
		return [
			Suggestion<SlashItem, SlashItem>({
				editor: this.editor,
				char: '/',
				startOfLine: true,
				allowSpaces: false,
				command: ({ editor, range, props }) => {
					props.run({ editor, range })
				},
				items: ({ query }) => filterItems(query),
				render: () => {
					let renderer: ReactRenderer<SlashCommandMenuHandle, MenuRendererProps> | null = null
					let unmount: (() => void) | null = null

					const buildProps = (props: SuggestionProps<SlashItem, SlashItem>): MenuRendererProps => ({
						items: props.items,
						command: (item) => props.command(item),
					})

					return {
						onStart: (props) => {
							renderer = new ReactRenderer(SlashCommandMenu, {
								props: buildProps(props),
								editor: props.editor,
							})
							unmount = props.mount(renderer.element)
						},
						onUpdate: (props) => {
							renderer?.updateProps(buildProps(props))
						},
						onKeyDown: (props: SuggestionKeyDownProps) => {
							if (props.event.key === 'Escape') {
								unmount?.()
								unmount = null
								renderer?.destroy()
								renderer = null
								return true
							}
							return renderer?.ref?.onKeyDown(props.event) ?? false
						},
						onExit: () => {
							unmount?.()
							unmount = null
							renderer?.destroy()
							renderer = null
						},
					}
				},
			}),
		]
	},
})
