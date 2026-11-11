import { detectMentionTrigger } from '@/components/chat/mention-picker'
import { tagChipClass } from '@/components/chat/tag-chip'
import { cn } from '@/lib/cn'
import type { MarkdownComposerHandle, MarkdownComposerProps } from '@maskin/markdown/react/composer'
import { Suspense, forwardRef, lazy } from 'react'

export type { MarkdownComposerHandle as RichComposerHandle }

// Dynamic-imported so Tiptap stays out of the main bundle; the chat box is the only caller.
const MarkdownComposer = lazy(() =>
	import('@maskin/markdown/react/composer').then((m) => ({ default: m.MarkdownComposer })),
)

export interface RichComposerInputProps
	extends Omit<MarkdownComposerProps, 'chipClass' | 'detectTrigger' | 'className'> {
	selfActorId: string | null
	/** Sizes the box (min and max height). */
	className?: string
}

/**
 * `<RichComposerInput>` is the chat message box with formatting: bold, italic, strikethrough,
 * inline code, code blocks, quotes, lists and links, by typing markdown or with the shortcuts.
 * `@` tags stay chips inside the sentence, like the plain tag input. The value is markdown.
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
					className={cn(
						'overflow-y-auto text-base [&_.ProseMirror]:min-h-[inherit] [&_.ProseMirror]:outline-none [&_p]:my-0 [&_p]:text-foreground [&_li]:text-foreground',
						className,
					)}
				/>
			</Suspense>
		)
	},
)
