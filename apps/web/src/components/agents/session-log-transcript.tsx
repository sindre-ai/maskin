import { MarkdownContent } from '@/components/shared/markdown-content'
import type { SessionLogResponse } from '@/lib/api'
import { cn } from '@/lib/cn'
import { type SindreEvent, parseSindreLine } from '@/lib/sindre-stream'
import { ChevronDown, ChevronRight, Settings, User, Wrench } from 'lucide-react'
import { useMemo, useState } from 'react'

type TranscriptItem =
	| { kind: 'event'; event: SindreEvent; logId: number }
	| { kind: 'system-line'; text: string; logId: number }
	| { kind: 'stderr'; text: string; logId: number }
	| { kind: 'plain-stdout'; text: string; logId: number }

export function buildSessionTranscript(logs: SessionLogResponse[]): TranscriptItem[] {
	const items: TranscriptItem[] = []
	for (const log of logs) {
		if (log.stream === 'stderr') {
			items.push({ kind: 'stderr', text: log.content, logId: log.id })
			continue
		}
		if (log.stream === 'system') {
			items.push({ kind: 'system-line', text: log.content, logId: log.id })
			continue
		}
		const events = parseSindreLine(log.content, { includeUser: true })
		if (events.length === 0) continue
		for (const event of events) {
			if (event.kind === 'debug') {
				items.push({ kind: 'plain-stdout', text: event.raw, logId: log.id })
				continue
			}
			items.push({ kind: 'event', event, logId: log.id })
		}
	}
	return items
}

export function getSessionResultDisplay(
	logs: SessionLogResponse[],
): { text: string; isError: boolean } | null {
	for (let i = logs.length - 1; i >= 0; i--) {
		const log = logs[i]
		if (log.stream !== 'stdout') continue
		const events = parseSindreLine(log.content)
		for (const event of events) {
			if (event.kind === 'result' && event.text) {
				return { text: event.text, isError: event.isError }
			}
		}
	}
	return null
}

/**
 * The interactive CLI keeps the container alive between turns: after each
 * `result` envelope it just waits for the next stdin write. From this panel
 * the user can't send a turn, so a session in that state is effectively
 * idle — the DB still says `status: running`, but nothing is happening
 * until the timeout fires. This returns true when the most recent
 * stream-json envelope on stdout is a `result`, i.e. the last turn is over
 * and the agent is sitting idle.
 */
export function isSessionIdleAwaitingInput(logs: SessionLogResponse[]): boolean {
	for (let i = logs.length - 1; i >= 0; i--) {
		const log = logs[i]
		if (log.stream !== 'stdout') continue
		const events = parseSindreLine(log.content, { includeUser: true })
		if (events.length === 0) continue
		const last = events[events.length - 1]
		return last.kind === 'result'
	}
	return false
}

/**
 * Short, human-readable preview of the agent's most recent meaningful
 * activity, suitable for inline display next to a session card. Walks logs
 * in reverse and returns the first event we can describe — assistant text,
 * tool call, thinking, user input, etc. Skips noisy envelopes like
 * `system init` and the raw JSON the unfiltered stream-json line would
 * produce.
 */
export function getLatestActivityPreview(logs: SessionLogResponse[]): string | null {
	for (let i = logs.length - 1; i >= 0; i--) {
		const log = logs[i]
		if (log.stream === 'stderr') return truncate(log.content, 80)
		if (log.stream !== 'stdout') continue
		const events = parseSindreLine(log.content, { includeUser: true })
		for (let j = events.length - 1; j >= 0; j--) {
			const event = events[j]
			const summary = describeEvent(event)
			if (summary !== null) return summary
		}
	}
	return null
}

function describeEvent(event: SindreEvent): string | null {
	switch (event.kind) {
		case 'text':
			return truncate(event.text.replace(/\s+/g, ' ').trim(), 80) || null
		case 'tool_use':
			return `Using ${event.name}`
		case 'thinking':
			return event.redacted ? 'Thinking (redacted)…' : 'Thinking…'
		case 'user':
			return `You: ${truncate(event.text, 60)}`
		case 'result':
			return event.isError ? 'Errored — awaiting input' : 'Awaiting input'
		case 'error':
			return truncate(event.message, 80)
		case 'system':
		case 'debug':
			return null
	}
}

function truncate(text: string, max: number): string {
	if (text.length <= max) return text
	return `${text.slice(0, max - 1).trimEnd()}…`
}

interface SessionLogTranscriptProps {
	logs: SessionLogResponse[]
	className?: string
}

export function SessionLogTranscript({ logs, className }: SessionLogTranscriptProps) {
	const items = useMemo(() => buildSessionTranscript(logs), [logs])

	if (items.length === 0) {
		return <p className="text-sm text-muted-foreground py-4 text-center">No logs available</p>
	}

	return (
		<div
			className={cn('rounded-md border border-border bg-secondary/30 overflow-hidden', className)}
		>
			<div className="max-h-[60vh] overflow-y-auto p-3 flex flex-col gap-2">
				{items.map((item, idx) => (
					<TranscriptRow key={`${item.logId}-${idx}`} item={item} />
				))}
			</div>
		</div>
	)
}

function TranscriptRow({ item }: { item: TranscriptItem }) {
	if (item.kind === 'system-line') return <SystemLine text={item.text} />
	if (item.kind === 'stderr') return <StderrLine text={item.text} />
	if (item.kind === 'plain-stdout') return <PlainStdoutLine text={item.text} />
	return <EventBlock event={item.event} />
}

function EventBlock({ event }: { event: SindreEvent }) {
	switch (event.kind) {
		case 'text':
			return <AssistantTextBlock text={event.text} />
		case 'thinking':
			return <ThinkingBlock text={event.text} redacted={event.redacted} />
		case 'tool_use':
			return <ToolUseBlock name={event.name} input={event.input} />
		case 'user':
			return <UserMessageBlock text={event.text} />
		case 'system':
			return <SystemEventLine subtype={event.subtype} />
		case 'error':
			return <div className="text-xs text-error font-mono">{event.message}</div>
		case 'result':
		case 'debug':
			return null
	}
}

function SystemLine({ text }: { text: string }) {
	return (
		<div className="text-[11px] font-mono text-text-muted italic whitespace-pre-wrap break-words">
			{text}
		</div>
	)
}

function PlainStdoutLine({ text }: { text: string }) {
	return (
		<div className="text-[11px] font-mono text-text-muted whitespace-pre-wrap break-words">
			{text}
		</div>
	)
}

function StderrLine({ text }: { text: string }) {
	return <div className="text-xs font-mono text-error whitespace-pre-wrap break-words">{text}</div>
}

function SystemEventLine({ subtype }: { subtype: string }) {
	return (
		<div className="flex items-center gap-1.5 text-[11px] text-text-muted">
			<Settings size={12} />
			<span>
				system <span className="font-mono">{subtype}</span>
			</span>
		</div>
	)
}

function AssistantTextBlock({ text }: { text: string }) {
	return <MarkdownContent content={text} size="sm" />
}

function UserMessageBlock({ text }: { text: string }) {
	return (
		<div className="flex justify-end">
			<div className="flex max-w-[85%] items-start gap-1.5 rounded-md bg-accent px-3 py-2 text-accent-foreground text-sm">
				<User size={12} className="mt-1 shrink-0 opacity-70" aria-hidden />
				<span className="whitespace-pre-wrap break-words">{text}</span>
			</div>
		</div>
	)
}

function ToolUseBlock({ name, input }: { name: string; input: unknown }) {
	const [open, setOpen] = useState(false)
	const preview = describeToolInput(input)
	return (
		<div className="rounded-md border border-border bg-bg text-xs">
			<button
				type="button"
				onClick={() => setOpen((v) => !v)}
				className="flex w-full items-center gap-1.5 px-2 py-1.5 min-w-0 text-left text-text-secondary hover:bg-bg-hover cursor-pointer"
				aria-expanded={open}
			>
				{open ? (
					<ChevronDown size={14} className="shrink-0 text-text-muted" />
				) : (
					<ChevronRight size={14} className="shrink-0 text-text-muted" />
				)}
				<Wrench size={12} className="shrink-0 text-text-muted" />
				<span className="font-mono text-text shrink-0">{name}</span>
				{preview && !open && (
					<span className="truncate font-mono text-text-muted min-w-0 flex-1">{preview}</span>
				)}
			</button>
			{open && (
				<pre className="overflow-x-auto border-t border-border px-3 py-2 font-mono text-text-secondary text-xs whitespace-pre-wrap break-words">
					{formatToolInput(input)}
				</pre>
			)}
		</div>
	)
}

function ThinkingBlock({ text, redacted }: { text: string; redacted?: boolean }) {
	const [open, setOpen] = useState(false)
	const label = redacted ? 'Thinking (redacted)' : 'Thinking'
	const body = redacted
		? 'Anthropic withheld the internal reasoning for this turn. The agent still thought about the problem — the content just isn’t available here.'
		: text
	return (
		<div className="rounded-md border border-border bg-bg text-xs">
			<button
				type="button"
				onClick={() => setOpen((v) => !v)}
				className="flex w-full items-center gap-1.5 px-2 py-1.5 text-left text-text-secondary italic hover:bg-bg-hover cursor-pointer"
				aria-expanded={open}
			>
				{open ? (
					<ChevronDown size={14} className="shrink-0 not-italic text-text-muted" />
				) : (
					<ChevronRight size={14} className="shrink-0 not-italic text-text-muted" />
				)}
				<span className="text-text-muted">{label}</span>
			</button>
			{open && (
				<div className="whitespace-pre-wrap border-t border-border px-3 py-2 text-text-muted italic">
					{body}
				</div>
			)}
		</div>
	)
}

function describeToolInput(input: unknown): string | null {
	if (input == null) return null
	if (typeof input !== 'object') return String(input)
	const entries = Object.entries(input as Record<string, unknown>)
	if (entries.length === 0) return null
	const [firstKey, firstValue] = entries[0]
	const preview = typeof firstValue === 'string' ? firstValue : JSON.stringify(firstValue)
	return `${firstKey}: ${preview}`
}

function formatToolInput(input: unknown): string {
	if (input === undefined) return ''
	try {
		return JSON.stringify(input, null, 2)
	} catch {
		return String(input)
	}
}
