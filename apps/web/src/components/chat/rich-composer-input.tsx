import { createEmojiMenuView } from '@/components/chat/emoji-menu'
import { detectMentionTrigger } from '@/components/chat/mention-picker'
import { tagChipClass } from '@/components/chat/tag-chip'
import { cn } from '@/lib/cn'
import type {
	ComposerFormat,
	MarkdownComposerHandle,
	MarkdownComposerProps,
} from '@maskin/markdown/react/composer'
import { Suspense, forwardRef, lazy } from 'react'

export type { ComposerFormat, MarkdownComposerHandle as RichComposerHandle }

// Dynamic-imported so Tiptap stays out of the main bundle; the chat box is the only caller.
const MarkdownComposer = lazy(() =>
	import('@maskin/markdown/react/composer').then((m) => ({ default: m.MarkdownComposer })),
)

export interface RichComposerInputProps
	extends Omit<
		MarkdownComposerProps,
		'chipClass' | 'detectTrigger' | 'className' | 'createEmojiView'
	> {
	selfActorId: string | null
	/** Sizes the box (min and max height). */
	className?: string
}

/**
 * `<RichComposerInput>` is the chat message box with formatting: bold, italic, strikethrough,
 * inline code, code blocks, quotes, lists and links, by typing markdown or with the shortcuts.
 * `@` tags stay chips inside the sentence, like the plain tag input. Typing a colon and two letters
 * opens an emoji list. The value is markdown.
 */
export const RichComposerInput = forwardRef<MarkdownComposerHandle, RichComposerInputProps>(
	function RichComposerInput({ selfActorId, className, ...rest }, ref) {
		return (
			<Suspense
				fallback={
					<div className={cn('select-none text-muted-foreground', className)} aria-hidden>
						{rest.placeholder}
					</div>
				}
			>
				<MarkdownComposer
					ref={ref}
					{...rest}
					chipClass={(id) => tagChipClass('card', id === selfActorId)}
					detectTrigger={detectMentionTrigger}
					createEmojiView={createEmojiMenuView}
					className={cn(
						'overflow-y-auto text-base [&>[contenteditable]]:min-h-[inherit] [&>[contenteditable]]:outline-none [&_p]:my-0 [&_p]:text-foreground [&_li]:text-foreground',
						className,
					)}
				/>
			</Suspense>
		)
	},
)
