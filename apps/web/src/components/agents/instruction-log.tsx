import { MarkdownContent } from '@/components/shared/markdown-content'
import { Badge } from '@/components/ui/badge'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Spinner } from '@/components/ui/spinner'
import { useCreateSession } from '@/hooks/use-sessions'
import type { ActorResponse } from '@/lib/api'
import { getApiKey } from '@/lib/auth'
import { cn } from '@/lib/cn'
import { API_BASE } from '@/lib/constants'
import { type LogSegment, parseLogLines } from '@/lib/parse-session-logs'
import { fetchEventSource } from '@microsoft/fetch-event-source'
import {
	CheckCircle2,
	ChevronRight,
	Code,
	Lightbulb,
	SendHorizontal,
	Terminal,
	XCircle,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

type MessageStatus = 'sent' | 'streaming' | 'completed' | 'failed'

interface Message {
	id: string
	role: 'user' | 'agent'
	content: string
	status: MessageStatus
	sessionId?: string
	logs: string[]
}

function findLastMessageIndex(messages: Message[], sessionId: string): number {
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i].sessionId === sessionId) return i
	}
	return -1
}

interface InstructionLogProps {
	agent: ActorResponse
	workspaceId: string
}

export function InstructionLog({ agent, workspaceId }: InstructionLogProps) {
	const [messages, setMessages] = useState<Message[]>([])
	const [input, setInput] = useState('')
	const [streamingSessionId, setStreamingSessionId] = useState<string | null>(null)
	const messagesEndRef = useRef<HTMLDivElement>(null)
	const mountedRef = useRef(true)
	const createSession = useCreateSession(workspaceId)

	useEffect(() => {
		return () => {
			mountedRef.current = false
		}
	}, [])

	const isStreaming = streamingSessionId !== null

	const scrollToBottom = useCallback(() => {
		messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
	}, [])

	// Auto-scroll on new messages or log updates
	useEffect(() => {
		if (messages.length > 0) {
			scrollToBottom()
		}
	}, [messages.length, scrollToBottom])

	// SSE streaming for session logs
	useEffect(() => {
		if (!streamingSessionId) return

		const sessionId = streamingSessionId
		const controller = new AbortController()

		fetchEventSource(`${API_BASE}/sessions/${streamingSessionId}/logs/stream`, {
			signal: controller.signal,
			headers: {
				Authorization: `Bearer ${getApiKey()}`,
				'X-Workspace-Id': workspaceId,
			},
			onmessage(msg) {
				if (!msg.data) return

				if (msg.event === 'done') {
					setMessages((prev) => {
						const idx = findLastMessageIndex(prev, sessionId)
						if (idx === -1) return prev
						const updated = [...prev]
						updated[idx] = { ...updated[idx], status: 'completed' }
						return updated
					})
					setStreamingSessionId(null)
					return
				}

				if (msg.event === 'stdout' || msg.event === 'stderr') {
					setMessages((prev) => {
						const idx = findLastMessageIndex(prev, sessionId)
						if (idx === -1) return prev
						const updated = [...prev]
						const logs = [...updated[idx].logs, msg.data]
						updated[idx] = { ...updated[idx], logs, content: logs.join('\n') }
						return updated
					})
				}

				// Check for terminal system messages
				if (msg.event === 'system') {
					const content = msg.data.toLowerCase()
					if (content.includes('session completed') || content.includes('session failed')) {
						const failed = content.includes('failed')
						setMessages((prev) => {
							const idx = findLastMessageIndex(prev, sessionId)
							if (idx === -1) return prev
							const updated = [...prev]
							updated[idx] = { ...updated[idx], status: failed ? 'failed' : 'completed' }
							return updated
						})
						setStreamingSessionId(null)
					}
				}
			},
			onerror() {
				setMessages((prev) => {
					const idx = findLastMessageIndex(prev, sessionId)
					if (idx === -1 || prev[idx].status !== 'streaming') return prev
					const updated = [...prev]
					const msg = updated[idx]
					updated[idx] = {
						...msg,
						status: 'failed',
						content: msg.logs.length === 0 ? 'Connection lost' : msg.content,
					}
					return updated
				})
				setStreamingSessionId(null)
				controller.abort()
			},
			openWhenHidden: true,
		})

		return () => controller.abort()
	}, [streamingSessionId, workspaceId])

	const handleSend = useCallback(async () => {
		const prompt = input.trim()
		if (!prompt || isStreaming) return

		const userMsgId = crypto.randomUUID()
		const agentMsgId = crypto.randomUUID()

		// Add user message
		setMessages((prev) => [
			...prev,
			{ id: userMsgId, role: 'user', content: prompt, status: 'sent', logs: [] },
		])
		setInput('')

		try {
			const session = await createSession.mutateAsync({
				actor_id: agent.id,
				action_prompt: prompt,
			})

			if (!mountedRef.current) return

			// Add agent message with streaming status
			setMessages((prev) => [
				...prev,
				{
					id: agentMsgId,
					role: 'agent',
					content: '',
					status: 'streaming',
					sessionId: session.id,
					logs: [],
				},
			])
			setStreamingSessionId(session.id)
		} catch {
			if (!mountedRef.current) return

			// Add failed agent message
			setMessages((prev) => [
				...prev,
				{
					id: agentMsgId,
					role: 'agent',
					content: 'Failed to start session',
					status: 'failed',
					logs: [],
				},
			])
		}
	}, [input, isStreaming, agent.id, createSession])

	const handleKeyDown = useCallback(
		(e: React.KeyboardEvent) => {
			if (e.key === 'Enter' && !e.shiftKey) {
				e.preventDefault()
				handleSend()
			}
		},
		[handleSend],
	)

	return (
		<div className="mb-6">
			<h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground mb-2">
				Instruction Log
			</h3>
			<div className="rounded-md border border-border bg-surface/50">
				{/* Messages area */}
				{messages.length > 0 && (
					<div className="max-h-[600px] overflow-y-auto p-3 space-y-3">
						{messages.map((msg) => (
							<MessageBubble key={msg.id} message={msg} />
						))}
						<div ref={messagesEndRef} />
					</div>
				)}

				{/* Input area */}
				<div className="flex items-center gap-2 p-2 border-t border-border">
					<input
						type="text"
						value={input}
						onChange={(e) => setInput(e.target.value)}
						onKeyDown={handleKeyDown}
						placeholder={`Tell ${agent.name} what to do...`}
						disabled={isStreaming}
						className="flex-1 bg-transparent text-sm px-2 py-1.5 outline-none placeholder:text-muted-foreground disabled:opacity-50"
					/>
					<button
						type="button"
						onClick={handleSend}
						disabled={!input.trim() || isStreaming}
						className="shrink-0 rounded-md p-1.5 text-muted-foreground hover:text-foreground hover:bg-hover disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
					>
						<SendHorizontal size={16} />
					</button>
				</div>
			</div>
		</div>
	)
}

function MessageBubble({ message }: { message: Message }) {
	if (message.role === 'user') {
		return (
			<div className="flex justify-end">
				<div className="max-w-[80%] rounded-lg bg-accent/10 px-3 py-2 text-sm">
					{message.content}
				</div>
			</div>
		)
	}

	// Agent message
	return (
		<div className="flex justify-start">
			<div className="max-w-[90%] w-full rounded-lg bg-secondary/50 px-3 py-2 text-sm">
				{message.status === 'streaming' && message.logs.length === 0 && (
					<span className="flex items-center gap-2 text-muted-foreground">
						<Spinner />
						Working on it...
					</span>
				)}

				{message.logs.length > 0 && <StructuredLogView logs={message.logs} />}

				{message.status === 'streaming' && message.logs.length > 0 && (
					<span className="flex items-center gap-1.5 mt-2 text-xs text-muted-foreground">
						<Spinner />
					</span>
				)}

				{message.status === 'completed' && (
					<span className="flex items-center gap-1.5 mt-2 text-xs text-success">
						<CheckCircle2 size={12} />
						Done
					</span>
				)}

				{message.status === 'failed' && (
					<span className="flex items-center gap-1.5 mt-2 text-xs text-error">
						<XCircle size={12} />
						{message.logs.length === 0 ? message.content : 'Failed'}
					</span>
				)}
			</div>
		</div>
	)
}

function StructuredLogView({ logs }: { logs: string[] }) {
	const segments = useMemo(() => parseLogLines(logs), [logs])

	if (segments.length === 0) {
		return (
			<pre className="whitespace-pre-wrap font-mono text-xs leading-relaxed">{logs.join('\n')}</pre>
		)
	}

	return (
		<div className="space-y-1.5">
			{segments.map((segment, i) => (
				<SegmentRenderer key={`${segment.type}-${i}`} segment={segment} />
			))}
		</div>
	)
}

function SegmentRenderer({ segment }: { segment: LogSegment }) {
	switch (segment.type) {
		case 'tool_call':
			return <ToolCallSegment segment={segment} />
		case 'tool_result':
			return <ToolResultSegment segment={segment} />
		case 'thinking':
			return <ThinkingSegment segment={segment} />
		case 'error':
			return <ErrorSegment segment={segment} />
		case 'system':
			return <SystemSegment segment={segment} />
		case 'text':
		default:
			return <TextSegment segment={segment} />
	}
}

function ToolCallSegment({ segment }: { segment: LogSegment }) {
	const [open, setOpen] = useState(false)
	const hasContent = !!segment.content

	return (
		<Collapsible open={open} onOpenChange={setOpen}>
			<CollapsibleTrigger
				className={cn(
					'flex items-center gap-1.5 w-full text-left group',
					hasContent && 'cursor-pointer',
				)}
			>
				<Code size={12} className="text-accent shrink-0" />
				<Badge variant="outline" className="text-[10px] font-mono px-1.5 py-0">
					{segment.toolName ?? 'tool'}
				</Badge>
				{hasContent && (
					<ChevronRight
						size={10}
						className={cn('text-muted-foreground transition-transform', open && 'rotate-90')}
					/>
				)}
			</CollapsibleTrigger>
			{hasContent && (
				<CollapsibleContent>
					<pre className="mt-1 ml-5 whitespace-pre-wrap font-mono text-[11px] leading-relaxed text-muted-foreground border-l-2 border-accent/30 pl-2">
						{segment.content}
					</pre>
				</CollapsibleContent>
			)}
		</Collapsible>
	)
}

function ToolResultSegment({ segment }: { segment: LogSegment }) {
	const [open, setOpen] = useState(false)
	const isLong = segment.content.length > 200

	if (!isLong) {
		return (
			<pre className="ml-5 whitespace-pre-wrap font-mono text-[11px] leading-relaxed text-muted-foreground bg-muted/50 rounded px-2 py-1">
				{segment.content}
			</pre>
		)
	}

	return (
		<Collapsible open={open} onOpenChange={setOpen}>
			<CollapsibleTrigger className="ml-5 flex items-center gap-1 text-[11px] text-muted-foreground cursor-pointer hover:text-foreground transition-colors">
				<Terminal size={10} />
				<span>Result ({segment.content.split('\n').length} lines)</span>
				<ChevronRight size={10} className={cn('transition-transform', open && 'rotate-90')} />
			</CollapsibleTrigger>
			<CollapsibleContent>
				<pre className="mt-1 ml-5 whitespace-pre-wrap font-mono text-[11px] leading-relaxed text-muted-foreground bg-muted/50 rounded px-2 py-1 max-h-[300px] overflow-y-auto">
					{segment.content}
				</pre>
			</CollapsibleContent>
		</Collapsible>
	)
}

function ThinkingSegment({ segment }: { segment: LogSegment }) {
	const [open, setOpen] = useState(false)

	return (
		<Collapsible open={open} onOpenChange={setOpen}>
			<CollapsibleTrigger className="flex items-center gap-1.5 text-[11px] text-muted-foreground cursor-pointer hover:text-foreground transition-colors">
				<Lightbulb size={10} className="text-warning" />
				<span className="italic">Thinking...</span>
				<ChevronRight size={10} className={cn('transition-transform', open && 'rotate-90')} />
			</CollapsibleTrigger>
			<CollapsibleContent>
				<div className="mt-1 ml-4 text-[11px] text-muted-foreground italic border-l-2 border-warning/30 pl-2">
					<MarkdownContent content={segment.content} size="xs" />
				</div>
			</CollapsibleContent>
		</Collapsible>
	)
}

function ErrorSegment({ segment }: { segment: LogSegment }) {
	return (
		<div className="border-l-2 border-error pl-2">
			<pre className="whitespace-pre-wrap font-mono text-[11px] leading-relaxed text-error">
				{segment.content}
			</pre>
		</div>
	)
}

function SystemSegment({ segment }: { segment: LogSegment }) {
	return <p className="text-[11px] text-muted-foreground italic">{segment.content}</p>
}

function TextSegment({ segment }: { segment: LogSegment }) {
	// For short text, render inline. For longer content, use markdown.
	if (segment.content.length < 100 && !segment.content.includes('\n')) {
		return <p className="text-xs leading-relaxed">{segment.content}</p>
	}

	return (
		<div className="text-xs">
			<MarkdownContent content={segment.content} size="xs" />
		</div>
	)
}
