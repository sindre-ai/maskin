import { cn } from '@/lib/cn'
import type { Editor } from '@tiptap/react'
import { BubbleMenu } from '@tiptap/react/menus'
import { Bold, Code, Italic, Link as LinkIcon, Strikethrough } from 'lucide-react'
import { useCallback } from 'react'

// Bubble menu that surfaces the common inline-formatting affordances
// (bold, italic, strike, code, link) when text is selected. TipTap ships
// the positioning primitive (`BubbleMenu` from `@tiptap/react/menus`);
// we own the button chrome so it uses the same shadcn/Tailwind tokens as
// the rest of the design system.
export function EditorBubbleMenu({ editor }: { editor: Editor }) {
	const setLink = useCallback(() => {
		const prev = editor.getAttributes('link').href as string | undefined
		const url = window.prompt('Link URL', prev ?? '')
		if (url === null) return
		if (url === '') {
			editor.chain().focus().extendMarkRange('link').unsetLink().run()
			return
		}
		editor.chain().focus().extendMarkRange('link').setLink({ href: url }).run()
	}, [editor])

	return (
		<BubbleMenu
			editor={editor}
			options={{ placement: 'top' }}
			shouldShow={({ from, to, editor: e }) => {
				if (from === to) return false
				// Hide inside a code block — Ctrl/Cmd+B on a code block should
				// not toggle bold.
				return e.isEditable && !e.isActive('codeBlock')
			}}
			className="flex items-center gap-0.5 rounded-md border border-border bg-popover p-1 shadow-md"
		>
			<MenuButton
				label="Bold"
				icon={<Bold />}
				active={editor.isActive('bold')}
				onClick={() => editor.chain().focus().toggleBold().run()}
			/>
			<MenuButton
				label="Italic"
				icon={<Italic />}
				active={editor.isActive('italic')}
				onClick={() => editor.chain().focus().toggleItalic().run()}
			/>
			<MenuButton
				label="Strikethrough"
				icon={<Strikethrough />}
				active={editor.isActive('strike')}
				onClick={() => editor.chain().focus().toggleStrike().run()}
			/>
			<MenuButton
				label="Inline code"
				icon={<Code />}
				active={editor.isActive('code')}
				onClick={() => editor.chain().focus().toggleCode().run()}
			/>
			<MenuButton
				label="Link"
				icon={<LinkIcon />}
				active={editor.isActive('link')}
				onClick={setLink}
			/>
		</BubbleMenu>
	)
}

function MenuButton({
	label,
	icon,
	active,
	onClick,
}: {
	label: string
	icon: React.ReactNode
	active: boolean
	onClick: () => void
}) {
	return (
		<button
			type="button"
			aria-label={label}
			aria-pressed={active}
			title={label}
			className={cn(
				'inline-flex h-7 w-7 items-center justify-center rounded text-muted-foreground transition-colors',
				'hover:bg-accent hover:text-accent-foreground',
				active && 'bg-accent text-accent-foreground',
				'[&_svg]:size-3.5',
			)}
			onClick={onClick}
		>
			{icon}
		</button>
	)
}
