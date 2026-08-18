import { AgentOutput } from '@/components/shared/agent-output'
import type { SessionLogResponse } from '@/lib/api'
import { type ChatEvent, parseChatLine } from '@/lib/chat-stream'
import { cn } from '@/lib/cn'
import { ChevronDown, ChevronRight, Settings, User, Wrench } from 'lucide-react'
import { useMemo, useState } from 'react'

type TranscriptItem =
	| { kind: 'event'; event: ChatEvent; logId: number }
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
		const events = parseChatLine(log.content, { includeUser: true })
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
		const events = parseChatLine(log.content)
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
		const events = parseChatLine(log.content, { includeUser: true })
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
		const events = parseChatLine(log.content, { includeUser: true })
		for (let j = events.length - 1; j >= 0; j--) {
			const event = events[j]
			const summary = describeEvent(event)
			if (summary !== null) return summary
		}
	}
	return null
}

export interface ActivityStep {
	id: string
	kind: 'text' | 'tool_use' | 'thinking' | 'user' | 'error'
	text: string
}

export interface MessageActivitySegment {
	conversationMessageId: number
	steps: ActivityStep[]
	/**
	 * True once this turn called the conversation-reply tool. Lets the chat UI
	 * re-anchor a finished turn's dropdown to the reply message it actually
	 * produced instead of the message that triggered it — see
	 * `useConversationActivity`, which pairs `containsReply` segments with the
	 * same agent's own posted messages in order.
	 */
	containsReply: boolean
}

/**
 * Splits a session's full activity log into per-message chunks, keyed by the
 * `maskin_message_id` tag `SessionManager.writeInput()` writes onto each
 * turn's stdin envelope (see `conversationMessageId` on the `user` ChatEvent
 * variant). A single interactive session stays open and accumulates logs for
 * the whole lifetime of a chat conversation, so without this the UI would
 * have to show one giant dropdown mixing every reply's thinking and tool
 * calls together — this lets the chat thread show a separate dropdown under
 * each message instead. Steps that arrive before the first tagged turn
 * boundary (an older session whose earlier turns predate this tagging) are
 * returned separately as `unassigned` rather than silently dropped.
 */
export function segmentActivityByMessage(logs: SessionLogResponse[]): {
	segments: MessageActivitySegment[]
	unassigned: ActivityStep[]
} {
	const segments: MessageActivitySegment[] = []
	const unassigned: ActivityStep[] = []
	// A plain mutable ref (rather than a `let`) sidesteps TS control-flow
	// narrowing not tracking reassignment inside the forEach callback below.
	const cursor: { current: MessageActivitySegment | null } = { current: null }

	for (const log of logs) {
		if (log.stream === 'stderr') {
			const bucket = cursor.current?.steps ?? unassigned
			bucket.push({ id: `${log.id}-stderr`, kind: 'error', text: truncate(log.content, 100) })
			continue
		}
		if (log.stream !== 'stdout') continue
		const events = parseChatLine(log.content, { includeUser: true })
		events.forEach((event, index) => {
			// A tagged user turn starts a new segment — the boundary itself
			// isn't rendered as a step since the triggering message is already
			// shown as the actual chat bubble right above the dropdown.
			if (event.kind === 'user' && event.conversationMessageId !== undefined) {
				cursor.current = {
					conversationMessageId: event.conversationMessageId,
					steps: [],
					containsReply: false,
				}
				segments.push(cursor.current)
				return
			}
			if (event.kind === 'result' || event.kind === 'system' || event.kind === 'debug') return
			const bucket = cursor.current?.steps ?? unassigned
			// The agent's own wrap-up text right after replying just restates
			// the "Replied to the conversation." step above it — drop it so
			// Thinking sits directly above a single, clean reply line.
			if (event.kind === 'text') {
				const prev = bucket[bucket.length - 1]
				if (prev?.kind === 'tool_use' && prev.text === CONVERSATION_REPLY_LABEL) return
			}
			const summary = describeEvent(event)
			if (summary === null) return
			if (event.kind === 'tool_use' && summary === CONVERSATION_REPLY_LABEL && cursor.current) {
				cursor.current.containsReply = true
			}
			bucket.push({ id: `${log.id}-${index}`, kind: event.kind, text: summary })
		})
	}
	return { segments, unassigned }
}

const CONVERSATION_REPLY_LABEL = 'Replied to the conversation.'

function isConversationReplyTool(name: string): boolean {
	return name === 'post_conversation_message' || name.endsWith('__post_conversation_message')
}

function describeEvent(event: ChatEvent): string | null {
	switch (event.kind) {
		case 'text':
			return truncate(event.text.replace(/\s+/g, ' ').trim(), 80) || null
		case 'tool_use':
			return isConversationReplyTool(event.name) ? CONVERSATION_REPLY_LABEL : `Using ${event.name}`
		case 'thinking':
			return event.redacted ? 'Thinking (redacted)…' : 'Thinking…'
		case 'user':
			return 'The user sent a message'
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

function EventBlock({ event }: { event: ChatEvent }) {
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
		<div className="text-[11px] font-mono text-muted-foreground italic whitespace-pre-wrap break-words">
			{text}
		</div>
	)
}

function PlainStdoutLine({ text }: { text: string }) {
	return (
		<div className="text-[11px] font-mono text-muted-foreground whitespace-pre-wrap break-words">
			{text}
		</div>
	)
}

function StderrLine({ text }: { text: string }) {
	return <div className="text-xs font-mono text-error whitespace-pre-wrap break-words">{text}</div>
}

function SystemEventLine({ subtype }: { subtype: string }) {
	return (
		<div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
			<Settings size={12} />
			<span>
				system <span className="font-mono">{subtype}</span>
			</span>
		</div>
	)
}

function AssistantTextBlock({ text }: { text: string }) {
	return <AgentOutput content={text} size="sm" />
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
		<div className="rounded-md border border-border bg-muted text-xs">
			<button
				type="button"
				onClick={() => setOpen((v) => !v)}
				className="flex w-full items-center gap-1.5 px-2 py-1.5 min-w-0 text-left text-muted-foreground hover:bg-accent cursor-pointer"
				aria-expanded={open}
			>
				{open ? (
					<ChevronDown size={14} className="shrink-0 text-muted-foreground" />
				) : (
					<ChevronRight size={14} className="shrink-0 text-muted-foreground" />
				)}
				<Wrench size={12} className="shrink-0 text-muted-foreground" />
				<span className="font-mono text-foreground shrink-0">{name}</span>
				{preview && !open && (
					<span className="truncate font-mono text-muted-foreground min-w-0 flex-1">{preview}</span>
				)}
			</button>
			{open && (
				<pre className="overflow-x-auto border-t border-border px-3 py-2 font-mono text-muted-foreground text-xs whitespace-pre-wrap break-words">
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
		<div className="rounded-md border border-border bg-muted text-xs">
			<button
				type="button"
				onClick={() => setOpen((v) => !v)}
				className="flex w-full items-center gap-1.5 px-2 py-1.5 text-left text-muted-foreground italic hover:bg-accent cursor-pointer"
				aria-expanded={open}
			>
				{open ? (
					<ChevronDown size={14} className="shrink-0 not-italic text-muted-foreground" />
				) : (
					<ChevronRight size={14} className="shrink-0 not-italic text-muted-foreground" />
				)}
				<span className="text-muted-foreground">{label}</span>
			</button>
			{open && (
				<div className="whitespace-pre-wrap border-t border-border px-3 py-2 text-muted-foreground italic">
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
