import { SindreTranscript } from '@/components/sindre/sindre-transcript'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { Textarea } from '@/components/ui/textarea'
import { useSindreSession } from '@/hooks/use-sindre-session'
import { cn } from '@/lib/cn'
import { Send } from 'lucide-react'
import { type FormEvent, useCallback, useState } from 'react'

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
 *
 * This is the scaffold. Subsequent tasks (29 — transcript event rendering, 30 —
 * composer behavior, 31 — one-shot routing, 32-36 — slash picker + chips) build
 * on the structure established here.
 */
export function SindreChat({ workspaceId, sindreActorId, surface, className }: SindreChatProps) {
	const { status, events, error, send } = useSindreSession({ workspaceId, sindreActorId })

	const showTranscript = surface === 'sheet'
	const sessionReady = status === 'ready' || status === 'connecting'
	const starting = status === 'starting' || status === 'idle'

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
			<Composer onSend={send} disabled={!sessionReady || !sindreActorId} surface={surface} />
		</div>
	)
}

interface ComposerProps {
	onSend: (content: string) => Promise<void>
	disabled: boolean
	surface: SindreChatSurface
}

/**
 * Minimal scaffold composer. Task 30 owns the richer Enter/Shift+Enter
 * behavior, the streaming spinner, and the auto-resize tuning; the goal here
 * is to provide a single submit surface shared by sheet and pulse-bar so task
 * 30 can layer behavior on top without re-plumbing the send path.
 */
function Composer({ onSend, disabled, surface }: ComposerProps) {
	const [value, setValue] = useState('')
	const [sending, setSending] = useState(false)
	const canSend = value.trim().length > 0 && !disabled && !sending

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
				placeholder={surface === 'pulse-bar' ? 'Ask Sindre anything…' : 'Message Sindre'}
				className="min-h-[36px] flex-1 resize-none border-0 bg-transparent p-1 text-sm focus-visible:ring-0 focus-visible:ring-offset-0"
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
				{sending ? <Spinner /> : <Send size={16} />}
			</Button>
		</form>
	)
}
