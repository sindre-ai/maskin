import { ActorAvatar } from '@/components/shared/actor-avatar'
import { MarkdownContent } from '@/components/shared/markdown-content'
import { RelativeTime } from '@/components/shared/relative-time'
import { MessageActions } from '@/components/sindre/message-actions'
import { Button } from '@/components/ui/button'
import type { AgentChatMessage, ChatMessage, UserChatMessage } from '@/lib/chat-store'
import { cn } from '@/lib/cn'
import type { SindreEvent, UserAttachmentView } from '@/lib/sindre-stream'
import {
	ArrowDown,
	Bell,
	Box,
	ChevronDown,
	ChevronRight,
	FileText,
	RotateCcw,
	Wrench,
} from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

interface ConversationTranscriptProps {
	messages: ChatMessage[]
	currentUserId: string
	onRegenerate: (messageId: string) => void
	onRetryUserMessage: (messageId: string) => void
	onEditUserMessage: (text: string) => void
	className?: string
}

/** Messages from the same sender within this window share one avatar header. */
const GROUP_WINDOW_MS = 2 * 60 * 1000
/** Distance from the bottom (px) under which we keep auto-sticking to latest. */
const STICK_THRESHOLD = 80

/**
 * Multiplayer transcript: every message is attributed (avatar + name + time),
 * consecutive messages from the same sender are visually grouped (Slack-style),
 * and the scroller smart-sticks to the latest message only while the user is
 * already at the bottom — otherwise a "jump to latest" pill appears with a
 * count of unseen messages.
 */
export function ConversationTranscript({
	messages,
	currentUserId,
	onRegenerate,
	onRetryUserMessage,
	onEditUserMessage,
	className,
}: ConversationTranscriptProps) {
	const scrollerRef = useRef<HTMLDivElement | null>(null)
	const stickRef = useRef(true)
	const [showJump, setShowJump] = useState(false)
	const [unseen, setUnseen] = useState(0)
	const prevCountRef = useRef(messages.length)

	const scrollToBottom = useCallback((behavior: ScrollBehavior = 'smooth') => {
		const el = scrollerRef.current
		if (!el) return
		el.scrollTo({ top: el.scrollHeight, behavior })
		stickRef.current = true
		setShowJump(false)
		setUnseen(0)
	}, [])

	const handleScroll = useCallback(() => {
		const el = scrollerRef.current
		if (!el) return
		const distance = el.scrollHeight - el.scrollTop - el.clientHeight
		const atBottom = distance <= STICK_THRESHOLD
		stickRef.current = atBottom
		if (atBottom) {
			setShowJump(false)
			setUnseen(0)
		}
	}, [])

	// Stick to the latest content while streaming / on new messages, but only
	// if the user hasn't scrolled up. Runs on every messages change (including
	// streamed token growth via new array identity).
	useLayoutEffect(() => {
		const el = scrollerRef.current
		if (!el) return
		const added = messages.length - prevCountRef.current
		prevCountRef.current = messages.length
		if (stickRef.current) {
			el.scrollTop = el.scrollHeight
		} else if (added > 0) {
			setShowJump(true)
			setUnseen((n) => n + added)
		}
	}, [messages])

	if (messages.length === 0) {
		return <div className={cn('min-h-0 flex-1', className)} />
	}

	return (
		<div className={cn('relative min-h-0 flex-1', className)}>
			<div ref={scrollerRef} onScroll={handleScroll} className="h-full overflow-y-auto px-1 py-2">
				<ol className="flex flex-col gap-0.5">
					{messages.map((message, index) => {
						const prev = messages[index - 1]
						const grouped =
							prev != null &&
							prev.senderId === message.senderId &&
							prev.role === message.role &&
							message.createdAt - prev.createdAt < GROUP_WINDOW_MS
						return (
							<MessageRow
								key={message.id}
								message={message}
								grouped={grouped}
								isSelf={message.role === 'user' && message.senderId === currentUserId}
								onRegenerate={() => onRegenerate(message.id)}
								onRetry={message.role === 'user' ? () => onRetryUserMessage(message.id) : undefined}
								onEdit={message.role === 'user' ? () => onEditUserMessage(message.text) : undefined}
							/>
						)
					})}
				</ol>
			</div>
			{showJump ? (
				<div className="-translate-x-1/2 absolute bottom-3 left-1/2 z-10">
					<Button
						type="button"
						size="sm"
						variant="secondary"
						className="h-8 gap-1.5 rounded-full shadow-md"
						onClick={() => scrollToBottom()}
					>
						<ArrowDown size={14} />
						{unseen > 0 ? `${unseen} new message${unseen > 1 ? 's' : ''}` : 'Jump to latest'}
					</Button>
				</div>
			) : null}
		</div>
	)
}

function MessageRow({
	message,
	grouped,
	isSelf,
	onRegenerate,
	onRetry,
	onEdit,
}: {
	message: ChatMessage
	grouped: boolean
	isSelf: boolean
	onRegenerate: () => void
	onRetry?: () => void
	onEdit?: () => void
}) {
	const copyText = message.role === 'user' ? message.text : agentPlainText(message.events)
	return (
		<li
			className={cn(
				'group relative flex gap-2.5 rounded-md px-2 py-1 hover:bg-bg-hover/50',
				grouped ? 'mt-0' : 'mt-2',
			)}
		>
			<div className="w-6 shrink-0 pt-0.5">
				{grouped ? null : (
					<ActorAvatar
						name={message.senderName}
						type={message.role === 'agent' ? 'agent' : 'user'}
						size="md"
					/>
				)}
			</div>
			<div className="min-w-0 flex-1">
				{grouped ? null : (
					<div className="flex items-baseline gap-2">
						<span className="font-medium text-foreground text-sm">
							{isSelf ? 'You' : message.senderName}
						</span>
						<RelativeTime
							date={new Date(message.createdAt).toISOString()}
							className="text-text-muted text-xs"
						/>
					</div>
				)}
				<div className="mt-0.5 text-sm">
					{message.role === 'user' ? (
						<UserBody message={message} onRetry={onRetry} />
					) : (
						<AgentBody message={message} onRegenerate={onRegenerate} />
					)}
				</div>
			</div>
			{copyText.trim().length > 0 ? (
				<div className="absolute top-0 right-2 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
					<MessageActions
						copyText={copyText}
						onEdit={onEdit}
						onRegenerate={message.role === 'agent' ? onRegenerate : undefined}
					/>
				</div>
			) : null}
		</li>
	)
}

function UserBody({ message, onRetry }: { message: UserChatMessage; onRetry?: () => void }) {
	const { text, attachments, status, errorText } = message
	return (
		<div className="flex flex-col gap-1">
			{attachments && attachments.length > 0 ? (
				<ul className="flex flex-wrap gap-1" aria-label="Attached context">
					{attachments.map((a) => (
						<li
							key={attachmentKey(a)}
							className="inline-flex max-w-full items-center gap-1 rounded-full bg-bg-surface px-2 py-0.5 text-[11px] text-text-secondary"
						>
							<AttachmentIcon kind={a.kind} />
							<span className="max-w-[12rem] truncate">{attachmentLabel(a)}</span>
						</li>
					))}
				</ul>
			) : null}
			<span className="whitespace-pre-wrap text-foreground">{text}</span>
			{status === 'error' ? (
				<div className="mt-0.5 flex items-center gap-2">
					<p className="text-error text-xs">{errorText ?? "Couldn't send."}</p>
					{onRetry ? (
						<Button
							type="button"
							size="sm"
							variant="outline"
							className="h-6 gap-1.5 px-2 text-xs"
							onClick={onRetry}
						>
							<RotateCcw size={12} />
							Retry
						</Button>
					) : null}
				</div>
			) : status === 'sending' ? (
				<p className="text-text-muted text-xs italic">Sending…</p>
			) : null}
		</div>
	)
}

function AgentBody({
	message,
	onRegenerate,
}: {
	message: AgentChatMessage
	onRegenerate: () => void
}) {
	const hasContent = message.events.some((e) => e.kind === 'text' && e.text.trim().length > 0)

	if (message.status === 'error') {
		return (
			<div className="flex flex-col items-start gap-1.5">
				<p className="text-error text-xs">{message.errorText ?? 'Something went wrong.'}</p>
				<Button
					type="button"
					size="sm"
					variant="outline"
					className="h-7 gap-1.5"
					onClick={onRegenerate}
				>
					<RotateCcw size={13} />
					Retry
				</Button>
			</div>
		)
	}

	return (
		<div className="flex flex-col gap-1.5">
			{message.events.map((event, i) => (
				<EventBlock key={`${event.kind}-${i}`} event={event} />
			))}
			{message.status === 'streaming' && !hasContent ? <WorkingIndicator /> : null}
			{message.status === 'streaming' && hasContent ? <StreamingCaret /> : null}
			{message.status === 'cancelled' ? (
				<p className="text-text-muted text-xs italic">Stopped</p>
			) : null}
		</div>
	)
}

function WorkingIndicator() {
	return (
		<div className="flex items-center gap-1.5 text-text-muted">
			<span className="flex gap-1">
				<Dot delay="0ms" />
				<Dot delay="150ms" />
				<Dot delay="300ms" />
			</span>
			<span className="text-xs">working…</span>
		</div>
	)
}

function Dot({ delay }: { delay: string }) {
	return (
		<span
			className="h-1.5 w-1.5 animate-bounce rounded-full bg-text-muted"
			style={{ animationDelay: delay }}
		/>
	)
}

function StreamingCaret() {
	return (
		<span className="ml-0.5 inline-block h-3.5 w-1.5 animate-pulse rounded-sm bg-primary/70 align-middle" />
	)
}

function EventBlock({ event }: { event: SindreEvent }) {
	switch (event.kind) {
		case 'text':
			if (event.text.trim().length === 0) return null
			return (
				<MarkdownContent
					content={event.text}
					size="sm"
					className="[&_li]:!text-foreground [&_p]:!text-foreground"
				/>
			)
		case 'thinking':
			return <ThinkingBlock text={event.text} redacted={event.redacted} />
		case 'tool_use':
			return <ToolUseBlock name={event.name} input={event.input} />
		default:
			return null
	}
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
				{preview && !open ? (
					<span className="truncate font-mono text-text-muted">{preview}</span>
				) : null}
			</button>
			{open ? (
				<pre className="overflow-x-auto border-t border-border px-3 py-2 font-mono text-text-secondary text-xs">
					{formatToolInput(input)}
				</pre>
			) : null}
		</div>
	)
}

function ThinkingBlock({ text, redacted }: { text: string; redacted?: boolean }) {
	const [open, setOpen] = useState(false)
	const label = redacted ? 'Thinking (redacted)' : 'Thinking'
	const body = redacted ? 'The internal reasoning for this turn was withheld.' : text
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
			{open ? (
				<div className="whitespace-pre-wrap border-t border-border px-3 py-2 text-text-muted italic">
					{body}
				</div>
			) : null}
		</div>
	)
}

function agentPlainText(events: SindreEvent[]): string {
	return events
		.filter((e): e is Extract<SindreEvent, { kind: 'text' }> => e.kind === 'text')
		.map((e) => e.text)
		.join('')
}

function attachmentKey(a: UserAttachmentView): string {
	if (a.kind === 'file') return `file:${a.name}`
	return `${a.kind}:${a.id}`
}

function AttachmentIcon({ kind }: { kind: UserAttachmentView['kind'] }) {
	if (kind === 'object') return <Box size={12} aria-hidden />
	if (kind === 'file') return <FileText size={12} aria-hidden />
	if (kind === 'notification') return <Bell size={12} aria-hidden />
	return <Box size={12} aria-hidden />
}

function attachmentLabel(a: UserAttachmentView): string {
	if (a.kind === 'agent') return a.name?.trim() || a.id
	if (a.kind === 'object') return a.title?.trim() || a.id
	if (a.kind === 'file') return a.name
	return a.title?.trim() || a.id
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
