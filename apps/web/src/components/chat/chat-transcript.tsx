import { type Ask, AskBlock } from '@/components/chat/ask-block'
import { AgentOutput } from '@/components/shared/agent-output'
import { AttachedFileCard } from '@/components/shared/attached-file-card'
import { ObjectReference } from '@/components/shared/object-reference'
import { Spinner } from '@/components/ui/spinner'
import type { ChatEvent, UserAttachmentView } from '@/lib/chat-stream'
import { cn } from '@/lib/cn'
import { Bell, Bot, Box, ChevronDown, ChevronRight, FileText, Wrench } from 'lucide-react'
import { type ReactNode, useEffect, useRef, useState } from 'react'

interface ChatTranscriptProps {
	workspaceId: string
	events: ChatEvent[]
	/** `needs_input` notifications bound to this conversation, rendered as tappable decision blocks. */
	asks?: Ask[]
	starting: boolean
	error: Error | null
	className?: string
}

/**
 * Renders the chat transcript — assistant text as markdown, tool_use as a
 * collapsible block (closed by default, click to inspect input), thinking as a
 * collapsed expander. Attachments render as reference cards above the message
 * they belong to (YOU ATTACHED on the human side, REFERENCED on the agent
 * side), successful runs render as a small result card, and open ask blocks
 * render as tappable choice rows. Non-renderable envelopes (user echoes,
 * system, debug) fall through to nothing so the surface stays quiet.
 */
export function ChatTranscript({
	workspaceId,
	events,
	asks,
	starting,
	error,
	className,
}: ChatTranscriptProps) {
	const scrollerRef = useRef<HTMLDivElement | null>(null)

	// biome-ignore lint/correctness/useExhaustiveDependencies: pin scroll to bottom on every new event
	useEffect(() => {
		const el = scrollerRef.current
		if (!el) return
		el.scrollTop = el.scrollHeight
	}, [events])

	const isEmpty = events.length === 0 && !error

	return (
		<div ref={scrollerRef} className={cn('overflow-y-auto p-3 text-sm', className)}>
			{isEmpty ? (
				<EmptyTranscript starting={starting} />
			) : (
				<div className="flex flex-col gap-3">
					{events.map((event, index) => (
						<TranscriptRow key={`${event.kind}-${index}`} event={event} workspaceId={workspaceId} />
					))}
					{asks && asks.length > 0
						? asks.map((ask) => <AskBlock key={ask.id} workspaceId={workspaceId} ask={ask} />)
						: null}
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
				<span>Connecting to agent…</span>
			</div>
		)
	}
	return (
		<div className="flex h-full items-center justify-center text-center text-text-muted">
			Ask the agents about your workspace — notifications, objects, bets, or how to get started.
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

function TranscriptRow({ event, workspaceId }: { event: ChatEvent; workspaceId: string }) {
	switch (event.kind) {
		case 'user':
			return (
				<UserMessageBlock
					text={event.text}
					attachments={event.attachments}
					workspaceId={workspaceId}
				/>
			)
		case 'text':
			return (
				<AssistantTextBlock
					text={event.text}
					attachments={event.attachments}
					workspaceId={workspaceId}
				/>
			)
		case 'thinking':
			return <ThinkingBlock text={event.text} redacted={event.redacted} />
		case 'tool_use':
			return <ToolUseBlock name={event.name} input={event.input} />
		case 'result':
			return <ResultBlock event={event} />
		case 'error':
			return <div className="text-error text-xs">{event.message}</div>
		case 'system':
		case 'debug':
			return null
	}
}

function UserMessageBlock({
	text,
	attachments,
	workspaceId,
}: {
	text: string
	attachments?: UserAttachmentView[]
	workspaceId: string
}) {
	const fileAttachments = attachments?.filter(
		(a): a is Extract<UserAttachmentView, { kind: 'file' }> => a.kind === 'file',
	)
	const objectAttachments = attachments?.filter(
		(a): a is Extract<UserAttachmentView, { kind: 'object' }> => a.kind === 'object',
	)
	const contextAttachments = attachments?.filter((a) => a.kind !== 'file' && a.kind !== 'object')
	const hasReferenceStack =
		(fileAttachments?.length ?? 0) > 0 || (objectAttachments?.length ?? 0) > 0

	return (
		<div className="flex flex-col items-end gap-1">
			{hasReferenceStack ? <MicroLabel>You attached</MicroLabel> : null}
			{fileAttachments && fileAttachments.length > 0 ? (
				<ul className="flex max-w-[85%] flex-col items-end gap-1" aria-label="Attached files">
					{fileAttachments.map((f) => (
						<li key={attachmentKey(f)} className="w-full">
							<AttachedFileCard
								workspaceId={workspaceId}
								file={{
									id: f.id,
									name: f.name,
									sizeBytes: f.sizeBytes,
									mimeType: f.mimeType,
								}}
							/>
						</li>
					))}
				</ul>
			) : null}
			{objectAttachments && objectAttachments.length > 0 ? (
				<ul className="flex flex-wrap justify-end gap-1" aria-label="Attached objects">
					{objectAttachments.map((o) => (
						<li
							key={attachmentKey(o)}
							className="inline-flex max-w-full items-center gap-1 rounded-full bg-accent-foreground/15 px-2 py-0.5 text-[11px] text-accent-foreground"
						>
							<Box size={12} aria-hidden />
							<span className="max-w-[12rem] truncate">{o.title?.trim() || o.id}</span>
						</li>
					))}
				</ul>
			) : null}
			<div className="flex max-w-[85%] flex-col gap-1 rounded-md bg-accent px-3 py-2 text-accent-foreground text-sm">
				{contextAttachments && contextAttachments.length > 0 ? (
					<ul className="flex flex-wrap gap-1" aria-label="Attached context">
						{contextAttachments.map((a) => (
							<li
								key={attachmentKey(a)}
								className="inline-flex max-w-full items-center gap-1 rounded-full bg-accent-foreground/15 px-2 py-0.5 text-[11px]"
							>
								<UserAttachmentIcon kind={a.kind} />
								<span className="max-w-[12rem] truncate">{userAttachmentLabel(a)}</span>
							</li>
						))}
					</ul>
				) : null}
				{text.length > 0 ? <span className="whitespace-pre-wrap">{text}</span> : null}
			</div>
		</div>
	)
}

function AssistantTextBlock({
	text,
	attachments,
	workspaceId,
}: {
	text: string
	attachments?: UserAttachmentView[]
	workspaceId: string
}) {
	const objectRefs = attachments?.filter(
		(a): a is Extract<UserAttachmentView, { kind: 'object' }> => a.kind === 'object',
	)
	const fileRefs = attachments?.filter(
		(a): a is Extract<UserAttachmentView, { kind: 'file' }> => a.kind === 'file',
	)
	const otherRefs = attachments?.filter((a) => a.kind !== 'object' && a.kind !== 'file')

	return (
		<div className="flex max-w-[85%] flex-col items-start gap-1.5">
			{attachments && attachments.length > 0 ? <MicroLabel>Referenced</MicroLabel> : null}
			{fileRefs && fileRefs.length > 0 ? (
				<ul className="flex w-full flex-col gap-1" aria-label="Referenced files">
					{fileRefs.map((f) => (
						<li key={attachmentKey(f)}>
							<AttachedFileCard
								workspaceId={workspaceId}
								file={{
									id: f.id,
									name: f.name,
									sizeBytes: f.sizeBytes,
									mimeType: f.mimeType,
								}}
							/>
						</li>
					))}
				</ul>
			) : null}
			{objectRefs && objectRefs.length > 0 ? (
				<ul className="flex w-full flex-col gap-1" aria-label="Referenced objects">
					{objectRefs.map((o) => (
						<li key={attachmentKey(o)} className="w-full">
							<ObjectReference
								workspaceId={workspaceId}
								objectId={o.id}
								variant="block"
								className="border border-border bg-bg"
							/>
						</li>
					))}
				</ul>
			) : null}
			{otherRefs && otherRefs.length > 0 ? (
				<ul className="flex flex-wrap gap-1" aria-label="Referenced context">
					{otherRefs.map((a) => (
						<li
							key={attachmentKey(a)}
							className="inline-flex max-w-full items-center gap-1 rounded-full bg-accent-foreground/15 px-2 py-0.5 text-[11px]"
						>
							<UserAttachmentIcon kind={a.kind} />
							<span className="max-w-[12rem] truncate">{userAttachmentLabel(a)}</span>
						</li>
					))}
				</ul>
			) : null}
			<AgentOutput content={text} size="sm" />
		</div>
	)
}

/**
 * Renders a successful run as a small result card — the mockup's inline viz
 * block, fed by the real per-turn metrics the result envelope carries
 * (duration, turn count, cost). Successful tool results otherwise have no
 * visual in the transcript, so this also closes that silent gap.
 */
function ResultBlock({ event }: { event: Extract<ChatEvent, { kind: 'result' }> }) {
	if (event.isError) {
		return <div className="text-error text-xs">{event.text ?? `Run failed (${event.subtype})`}</div>
	}
	const durationLabel = event.durationMs != null ? `${(event.durationMs / 1000).toFixed(1)}s` : null
	const pct = event.durationMs != null ? Math.max(0, Math.min(1, event.durationMs / 60_000)) : 0
	return (
		<div className="w-full max-w-sm rounded-md border border-border bg-bg p-3">
			<div className="flex items-baseline justify-between gap-2">
				<MicroLabel>Run</MicroLabel>
				<span className="font-mono text-[10px] uppercase text-text-muted">{event.subtype}</span>
			</div>
			<div className="mt-1.5 flex items-baseline gap-1.5">
				<span className="font-mono text-lg font-semibold text-text tabular-nums">
					{durationLabel ?? '—'}
				</span>
				<span className="font-mono text-[10px] uppercase text-text-muted">duration</span>
			</div>
			<div
				aria-label={`${event.subtype} run: ${Math.round(pct * 100)}% of budget`}
				className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-bg-hover"
			>
				<div
					className="h-full rounded-full bg-accent transition-[width] duration-200"
					style={{ width: `${Math.round(pct * 100)}%` }}
				/>
			</div>
			{event.text ? <p className="mt-2 text-xs text-text-secondary">{event.text}</p> : null}
			{event.numTurns != null || event.totalCostUsd != null ? (
				<div className="mt-2 flex gap-3 font-mono text-[10px] text-text-muted">
					{event.numTurns != null ? (
						<span>
							{event.numTurns} {event.numTurns === 1 ? 'turn' : 'turns'}
						</span>
					) : null}
					{event.totalCostUsd != null ? <span>${event.totalCostUsd.toFixed(2)}</span> : null}
				</div>
			) : null}
		</div>
	)
}

function MicroLabel({ children }: { children: ReactNode }) {
	return (
		<span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
			{children}
		</span>
	)
}

function attachmentKey(a: UserAttachmentView): string {
	if (a.kind === 'file') return `file:${a.id ?? a.name}`
	return `${a.kind}:${a.id}`
}

function UserAttachmentIcon({ kind }: { kind: UserAttachmentView['kind'] }) {
	if (kind === 'agent') return <Bot size={12} aria-hidden />
	if (kind === 'object') return <Box size={12} aria-hidden />
	if (kind === 'file') return <FileText size={12} aria-hidden />
	return <Bell size={12} aria-hidden />
}

function userAttachmentLabel(a: UserAttachmentView): string {
	if (a.kind === 'agent') return a.name?.trim() || a.id
	if (a.kind === 'object') return a.title?.trim() || a.id
	if (a.kind === 'file') return a.name
	return a.title?.trim() || a.id
}

function ToolUseBlock({ name, input }: { name: string; input: unknown }) {
	const [open, setOpen] = useState(false)
	const preview = describeToolInput(input)
	return (
		<div className="rounded-md border border-border bg-bg text-xs">
			<button
				type="button"
				onClick={() => setOpen((v) => !v)}
				className="flex w-full items-center gap-1.5 px-2 py-1.5 text-left text-text-secondary hover:bg-bg-hover"
				aria-expanded={open}
			>
				{open ? (
					<ChevronDown size={14} className="shrink-0 text-text-muted" />
				) : (
					<ChevronRight size={14} className="shrink-0 text-text-muted" />
				)}
				<Wrench size={12} className="shrink-0 text-text-muted" />
				<span className="font-mono text-text">{name}</span>
				{preview && !open && <span className="truncate font-mono text-text-muted">{preview}</span>}
			</button>
			{open && (
				<pre className="overflow-x-auto border-t border-border px-3 py-2 font-mono text-text-secondary text-xs">
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
				className="flex w-full items-center gap-1.5 px-2 py-1.5 text-left text-text-secondary italic hover:bg-bg-hover"
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
