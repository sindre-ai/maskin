import { SindreTranscript } from '@/components/sindre/sindre-transcript'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { Textarea } from '@/components/ui/textarea'
import { useSindreSession } from '@/hooks/use-sindre-session'
import { cn } from '@/lib/cn'
import type { SindreEvent } from '@/lib/sindre-stream'
import { Send } from 'lucide-react'
import { type FormEvent, type KeyboardEvent, useCallback, useEffect, useRef, useState } from 'react'

export type SindreChatSurface = 'sheet' | 'pulse-bar'

export interface SindreChatProps {
	workspaceId: string
	sindreActorId: string | null
	surface: SindreChatSurface
	className?: string
}

/**
 * Shared chat surface for Sindre. Composes `<Transcript />` above `<Composer />`
 * and hides the transcript in `pulse-bar` mode so the same component can render
 * as an input-only bar at the top of the Pulse page and as a full-height sheet
 * on the right-side overlay. Wires a single long-lived interactive session via
 * `useSindreSession`.
 */
export function SindreChat({ workspaceId, sindreActorId, surface, className }: SindreChatProps) {
	const { status, events, error, send } = useSindreSession({ workspaceId, sindreActorId })

	const showTranscript = surface === 'sheet'
	const sessionReady = status === 'ready' || status === 'connecting'
	const starting = status === 'starting' || status === 'idle'

	const [pendingTurn, setPendingTurn] = useState(false)
	const pendingBaselineRef = useRef(0)

	// Clear pendingTurn once the assistant emits the first event for this turn.
	// `result` is included so turns that end without any content (e.g. an empty
	// or errored run) also release the composer instead of stranding it.
	useEffect(() => {
		if (!pendingTurn) return
		for (let i = pendingBaselineRef.current; i < events.length; i++) {
			if (isTurnProgressEvent(events[i])) {
				setPendingTurn(false)
				return
			}
		}
	}, [pendingTurn, events])

	const handleSend = useCallback(
		async (content: string) => {
			pendingBaselineRef.current = events.length
			setPendingTurn(true)
			try {
				await send(content)
			} catch (err) {
				setPendingTurn(false)
				throw err
			}
		},
		[events.length, send],
	)

	return (
		<div
			className={cn(
				'flex min-h-0 flex-col gap-2',
				surface === 'sheet' ? 'h-full' : 'w-full',
				className,
			)}
			data-surface={surface}
		>
			{showTranscript && (
				<SindreTranscript
					events={events}
					starting={starting}
					error={error}
					className="min-h-0 flex-1"
				/>
			)}
			<Composer
				onSend={handleSend}
				disabled={!sessionReady || !sindreActorId}
				pending={pendingTurn}
				surface={surface}
			/>
		</div>
	)
}

function isTurnProgressEvent(event: SindreEvent): boolean {
	return (
		event.kind === 'text' ||
		event.kind === 'tool_use' ||
		event.kind === 'thinking' ||
		event.kind === 'result'
	)
}

interface ComposerProps {
	onSend: (content: string) => Promise<void>
	disabled: boolean
	pending: boolean
	surface: SindreChatSurface
}

/**
 * Chat composer for Sindre. Enter sends, Shift+Enter inserts a newline, IME
 * composition swallows Enter. The textarea auto-resizes up to `max-h-40` and
 * scrolls beyond that. The send button shows a Spinner (and stays disabled)
 * while a turn is pending — i.e. after a send, until the first assistant
 * event lands.
 */
function Composer({ onSend, disabled, pending, surface }: ComposerProps) {
	const [value, setValue] = useState('')
	const [sending, setSending] = useState(false)
	const canSend = value.trim().length > 0 && !disabled && !sending && !pending
	const showSpinner = sending || pending

	const handleSubmit = useCallback(
		async (e?: FormEvent<HTMLFormElement>) => {
			e?.preventDefault()
			if (!canSend) return
			const content = value.trim()
			setSending(true)
			try {
				await onSend(content)
				setValue('')
			} finally {
				setSending(false)
			}
		},
		[canSend, onSend, value],
	)

	const handleKeyDown = useCallback(
		(e: KeyboardEvent<HTMLTextAreaElement>) => {
			if (e.key !== 'Enter') return
			if (e.shiftKey) return
			if (e.nativeEvent.isComposing) return
			e.preventDefault()
			void handleSubmit()
		},
		[handleSubmit],
	)

	return (
		<form
			onSubmit={handleSubmit}
			className={cn(
				'flex items-end gap-2 rounded-md border border-border bg-bg-surface p-2',
				surface === 'pulse-bar' && 'shadow-sm',
			)}
		>
			<Textarea
				autoResize
				value={value}
				onChange={(e) => setValue(e.target.value)}
				onKeyDown={handleKeyDown}
				placeholder={surface === 'pulse-bar' ? 'Ask Sindre anything…' : 'Message Sindre'}
				className="max-h-40 min-h-[36px] flex-1 resize-none overflow-y-auto border-0 bg-transparent p-1 text-sm focus-visible:ring-0 focus-visible:ring-offset-0"
				disabled={disabled}
				rows={1}
			/>
			<Button
				type="submit"
				size="icon"
				variant="ghost"
				disabled={!canSend}
				aria-label="Send message"
			>
				{showSpinner ? <Spinner /> : <Send size={16} />}
			</Button>
		</form>
	)
}
