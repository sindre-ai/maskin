import { MarkdownContent } from '@/components/shared/markdown-content'
import { Spinner } from '@/components/ui/spinner'
import { cn } from '@/lib/cn'
import type { SindreEvent, UserAttachmentView } from '@/lib/sindre-stream'
import { Bell, Bot, Box, ChevronDown, ChevronRight, Wrench } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

interface SindreTranscriptProps {
	events: SindreEvent[]
	starting: boolean
	error: Error | null
	className?: string
}

/**
 * Renders the Sindre transcript — assistant text as markdown, tool_use as a
 * collapsible block (closed by default, click to inspect input), and thinking
 * as a collapsed expander. Non-renderable envelopes (user echoes, success
 * results, system, debug) fall through to nothing so the surface stays quiet.
 */
export function SindreTranscript({ events, starting, error, className }: SindreTranscriptProps) {
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
				'overflow-y-auto p-3 text-sm',
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
		case 'user':
			return <UserMessageBlock text={event.text} attachments={event.attachments} />
		case 'text':
			return <AssistantTextBlock text={event.text} />
		case 'thinking':
			return <ThinkingBlock text={event.text} />
		case 'tool_use':
			return <ToolUseBlock name={event.name} input={event.input} />
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
		case 'debug':
			return null
	}
}

function UserMessageBlock({
	text,
	attachments,
}: {
	text: string
	attachments?: UserAttachmentView[]
}) {
	return (
		<div className="flex justify-end">
			<div className="flex max-w-[85%] flex-col gap-1 rounded-md bg-accent px-3 py-2 text-accent-foreground text-sm">
				{attachments && attachments.length > 0 ? (
					<ul className="flex flex-wrap gap-1" aria-label="Attached context">
						{attachments.map((a) => (
							<li
								key={`${a.kind}:${a.id}`}
								className="inline-flex max-w-full items-center gap-1 rounded-full bg-accent-foreground/15 px-2 py-0.5 text-[11px]"
							>
								<UserAttachmentIcon kind={a.kind} />
								<span className="max-w-[12rem] truncate">{userAttachmentLabel(a)}</span>
							</li>
						))}
					</ul>
				) : null}
				<span className="whitespace-pre-wrap">{text}</span>
			</div>
		</div>
	)
}

function UserAttachmentIcon({ kind }: { kind: UserAttachmentView['kind'] }) {
	if (kind === 'agent') return <Bot size={12} aria-hidden />
	if (kind === 'object') return <Box size={12} aria-hidden />
	return <Bell size={12} aria-hidden />
}

function userAttachmentLabel(a: UserAttachmentView): string {
	if (a.kind === 'agent') return a.name?.trim() || a.id
	if (a.kind === 'object') return a.title?.trim() || a.id
	return a.title?.trim() || a.id
}

function AssistantTextBlock({ text }: { text: string }) {
	// MarkdownContent applies `prose-p:text-muted-foreground` internally, which
	// overrides plain text-color classes on the outer wrapper. Target the
	// rendered <p>/<li> nodes directly so the body text matches the user
	// bubble's text-accent-foreground.
	return (
		<MarkdownContent
			content={text}
			className="[&_li]:!text-accent-foreground [&_p]:!text-accent-foreground"
			size="sm"
		/>
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

function ThinkingBlock({ text }: { text: string }) {
	const [open, setOpen] = useState(false)
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
				<span className="text-text-muted">Thinking</span>
			</button>
			{open && (
				<div className="whitespace-pre-wrap border-t border-border px-3 py-2 text-text-muted italic">
					{text}
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
