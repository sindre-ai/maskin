import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { trackForyouSparseComposerShown, trackForyouSparseComposerSubmit } from '@/lib/analytics'
import { useChat } from '@/lib/chat-context'
import { cn } from '@/lib/cn'
import { Send } from 'lucide-react'
import {
	type ChangeEvent,
	type FormEvent,
	type KeyboardEvent,
	useCallback,
	useEffect,
	useRef,
	useState,
} from 'react'

const QUICK_START_CHIPS = [
	'What should I work on next?',
	'Summarize what my agents did today',
	'Help me plan a new bet',
] as const

interface SparseComposerProps {
	itemsCount: number
}

/**
 * Composer rendered on the For You page when the feed is sparse
 * (`items.length < 3`). On submit it stages the message in `chatContext` via
 * `openWithContext([], message)` — the sidebar's own composer then auto-sends
 * it as the first turn in a fresh thread.
 *
 * Chrome mirrors the sidebar's `Composer` (rounded border, right-aligned send
 * icon, Enter-to-send + Shift+Enter newline + IME `isComposing` guard) so the
 * two surfaces feel like one input that travels with the conversation.
 */
export function SparseComposer({ itemsCount }: SparseComposerProps) {
	const { openWithContext } = useChat()
	const [value, setValue] = useState('')
	const [sending, setSending] = useState(false)
	const [error, setError] = useState<string | null>(null)
	// `items_count` is snapshotted at mount so the `_shown` event reflects the
	// state that produced this composer, not whatever the feed mutates into.
	const mountedItemsCount = useRef(itemsCount)

	useEffect(() => {
		trackForyouSparseComposerShown({ items_count: mountedItemsCount.current })
	}, [])

	const submit = useCallback(
		async (text: string) => {
			const content = text.trim()
			if (!content) return
			if (sending) return
			setSending(true)
			setError(null)
			const itemsCountAtSubmit = itemsCount
			try {
				await Promise.resolve(openWithContext([], content))
				trackForyouSparseComposerSubmit({ items_count: itemsCountAtSubmit })
				setValue('')
			} catch (err) {
				setError(err instanceof Error ? err.message : 'Could not open chat — try again.')
			} finally {
				setSending(false)
			}
		},
		[itemsCount, openWithContext, sending],
	)

	const handleSubmit = useCallback(
		(e?: FormEvent<HTMLFormElement>) => {
			e?.preventDefault()
			void submit(value)
		},
		[submit, value],
	)

	const handleKeyDown = useCallback(
		(e: KeyboardEvent<HTMLTextAreaElement>) => {
			if (e.key !== 'Enter') return
			if (e.shiftKey) return
			if (e.nativeEvent.isComposing) return
			e.preventDefault()
			void submit(value)
		},
		[submit, value],
	)

	const handleChange = useCallback((e: ChangeEvent<HTMLTextAreaElement>) => {
		setValue(e.target.value)
	}, [])

	const handleChipClick = useCallback(
		(text: string) => {
			void submit(text)
		},
		[submit],
	)

	const canSend = value.trim().length > 0 && !sending
	const showChips = itemsCount === 0

	return (
		<div className="space-y-2">
			{showChips ? (
				<div className="flex flex-wrap gap-2" data-testid="sparse-composer-chips">
					{QUICK_START_CHIPS.map((text) => (
						<Button
							key={text}
							type="button"
							size="sm"
							variant="outline"
							className="h-7 rounded-full px-3 text-xs"
							onClick={() => handleChipClick(text)}
							disabled={sending}
						>
							{text}
						</Button>
					))}
				</div>
			) : null}
			<div
				className={cn(
					'relative flex flex-col gap-1 rounded-md border border-border bg-bg-surface p-2 shadow-sm',
				)}
				data-testid="sparse-composer"
			>
				<form onSubmit={handleSubmit}>
					<Textarea
						autoResize
						value={value}
						onChange={handleChange}
						onKeyDown={handleKeyDown}
						placeholder="Ask agents to start something…"
						className="max-h-40 min-h-[36px] w-full resize-none overflow-y-auto border-0 bg-transparent p-1 text-sm focus-visible:ring-0 focus-visible:ring-offset-0"
						disabled={sending}
						rows={1}
						aria-label="Start a chat with agents"
					/>
					{error ? (
						<p role="alert" aria-live="polite" className="px-1 text-error text-xs">
							{error} Your message is preserved.
						</p>
					) : null}
					<div className="flex items-center">
						<div className="ml-auto">
							<Button
								type="submit"
								size="icon"
								variant="ghost"
								disabled={!canSend}
								aria-label="Send message"
							>
								<Send size={16} />
							</Button>
						</div>
					</div>
				</form>
			</div>
		</div>
	)
}
