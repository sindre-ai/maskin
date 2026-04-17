import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { Textarea } from '@/components/ui/textarea'
import { useSindreSession } from '@/hooks/use-sindre-session'
import { cn } from '@/lib/cn'
import type { SindreEvent } from '@/lib/sindre-stream'
import { Send } from 'lucide-react'
import { type FormEvent, useCallback, useEffect, useRef, useState } from 'react'

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
				<Transcript events={events} starting={starting} error={error} className="min-h-0 flex-1" />
			)}
			<Composer onSend={send} disabled={!sessionReady || !sindreActorId} surface={surface} />
		</div>
	)
}

interface TranscriptProps {
	events: SindreEvent[]
	starting: boolean
	error: Error | null
	className?: string
}

/**
 * Minimal scaffold renderer for the Sindre transcript. Each event kind is
 * rendered as its own row so later iterations can swap the row component for
 * a richer block (markdown for text, collapsible blocks for tool_use, collapsed
 * thinking with an expander) without touching the container or the session
 * wiring above.
 */
function Transcript({ events, starting, error, className }: TranscriptProps) {
	const scrollerRef = useRef<HTMLDivElement | null>(null)

	// biome-ignore lint/correctness/useExhaustiveDependencies: pin scroll to bottom on every new event
	useEffect(() => {
		const el = scrollerRef.current
		if (!el) return
		el.scrollTop = el.scrollHeight
	}, [events])

	const isEmpty = events.length === 0 && !error

	return (
		<div
			ref={scrollerRef}
			className={cn(
				'overflow-y-auto rounded-md border border-border bg-bg-surface p-3 text-sm',
				className,
			)}
		>
			{isEmpty ? (
				<EmptyTranscript starting={starting} />
			) : (
				<div className="flex flex-col gap-3">
					{events.map((event, index) => (
						<TranscriptRow key={`${event.kind}-${index}`} event={event} />
					))}
					{error && <TranscriptError error={error} />}
				</div>
			)}
		</div>
	)
}

function EmptyTranscript({ starting }: { starting: boolean }) {
	if (starting) {
		return (
			<div className="flex h-full items-center justify-center gap-2 text-text-muted">
				<Spinner />
				<span>Connecting to Sindre…</span>
			</div>
		)
	}
	return (
		<div className="flex h-full items-center justify-center text-center text-text-muted">
			Ask Sindre about your workspace — notifications, objects, bets, or how to get started.
		</div>
	)
}

function TranscriptError({ error }: { error: Error }) {
	return (
		<div className="rounded-md border border-error/40 bg-error/10 px-3 py-2 text-error text-xs">
			{error.message}
		</div>
	)
}

function TranscriptRow({ event }: { event: SindreEvent }) {
	switch (event.kind) {
		case 'text':
			return <div className="whitespace-pre-wrap text-text">{event.text}</div>
		case 'thinking':
			return <div className="whitespace-pre-wrap text-text-muted italic text-xs">{event.text}</div>
		case 'tool_use':
			return (
				<div className="rounded-md border border-border bg-bg px-2 py-1.5 font-mono text-text-secondary text-xs">
					<span className="text-text">{event.name}</span>
					<span className="text-text-muted">()</span>
				</div>
			)
		case 'result':
			if (event.isError) {
				return (
					<div className="text-error text-xs">{event.text ?? `Run failed (${event.subtype})`}</div>
				)
			}
			return null
		case 'error':
			return <div className="text-error text-xs">{event.message}</div>
		case 'system':
			return null
		case 'debug':
			return null
	}
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
