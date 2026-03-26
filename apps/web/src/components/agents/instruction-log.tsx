import { Spinner } from '@/components/ui/spinner'
import { useCreateSession } from '@/hooks/use-sessions'
import type { ActorResponse } from '@/lib/api'
import { getApiKey } from '@/lib/auth'
import { API_BASE } from '@/lib/constants'
import { fetchEventSource } from '@microsoft/fetch-event-source'
import { CheckCircle2, SendHorizontal, XCircle } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'

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
					<div className="max-h-[400px] overflow-y-auto p-3 space-y-3">
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
			<div className="max-w-[80%] rounded-lg bg-secondary/50 px-3 py-2 text-sm">
				{message.status === 'streaming' && message.logs.length === 0 && (
					<span className="flex items-center gap-2 text-muted-foreground">
						<Spinner />
						Working on it...
					</span>
				)}

				{message.logs.length > 0 && (
					<pre className="whitespace-pre-wrap font-mono text-xs leading-relaxed">
						{message.content}
					</pre>
				)}

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
