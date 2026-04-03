import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from '@/components/ui/select'
import { useEffect, useRef, useState } from 'react'
import { McpServers } from './mcp-servers'

interface AgentCreateFormProps {
	onAutoCreate: (data: { name: string }) => void
	onUpdate?: (data: Record<string, unknown>) => void
	agent?: import('@/lib/api').ActorResponse
	isPending?: boolean
	error?: Error | null
}

export function AgentCreateForm({
	onAutoCreate,
	onUpdate,
	agent,
	isPending = false,
	error,
}: AgentCreateFormProps) {
	const [name, setName] = useState('')
	const hasAutoCreatedRef = useRef(false)
	const [systemPromptDraft, setSystemPromptDraft] = useState('')
	const [llmProvider, setLlmProvider] = useState('anthropic')
	const [modelDraft, setModelDraft] = useState('')

	const isValid = name.trim().length > 0

	// Auto-create when form first becomes valid
	useEffect(() => {
		if (!isValid || hasAutoCreatedRef.current) return
		hasAutoCreatedRef.current = true
		onAutoCreate({ name: name.trim() })
	}, [isValid, name, onAutoCreate])

	const handleNameBlur = () => {
		if (agent && name.trim() !== agent.name && onUpdate) {
			onUpdate({ name: name.trim() })
		}
	}

	const handleSystemPromptBlur = () => {
		if (agent && onUpdate) {
			onUpdate({ system_prompt: systemPromptDraft })
		}
	}

	const handleProviderChange = (provider: string) => {
		setLlmProvider(provider)
		if (agent && onUpdate) {
			onUpdate({ llm_provider: provider })
		}
	}

	const handleModelBlur = () => {
		if (agent && onUpdate) {
			onUpdate({ llm_config: { model: modelDraft || undefined } })
		}
	}

	const handleToolsUpdate = (tools: Record<string, unknown>) => {
		if (agent && onUpdate) {
			onUpdate({ tools })
		}
	}

	return (
		<div className="max-w-3xl mx-auto">
			{/* Name */}
			<textarea
				value={name}
				onChange={(e) => {
					setName(e.target.value)
					e.target.style.height = 'auto'
					e.target.style.height = `${e.target.scrollHeight}px`
				}}
				onBlur={handleNameBlur}
				onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
				placeholder="Agent name"
				// biome-ignore lint/a11y/noAutofocus: focus title on create
				autoFocus
				rows={1}
				className="w-full text-2xl font-bold tracking-tight bg-transparent border-none outline-none text-foreground mb-2 resize-none overflow-hidden p-0 focus:outline-none"
				ref={(el) => {
					if (el) {
						el.style.height = 'auto'
						el.style.height = `${el.scrollHeight}px`
					}
				}}
			/>

			{/* Metadata badges row */}
			<div className="flex flex-wrap items-center gap-2 mb-6">
				<span className="inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium text-type-agent-text bg-type-agent-bg">
					agent
				</span>
				<span className="flex items-center gap-1.5 text-xs">
					<span className="h-1.5 w-1.5 rounded-full bg-text-muted" />
					<span className="text-muted-foreground">idle</span>
				</span>
			</div>

			{/* System Prompt */}
			<Section title="System Prompt">
				<textarea
					value={systemPromptDraft}
					onChange={(e) => {
						setSystemPromptDraft(e.target.value)
						e.target.style.height = 'auto'
						e.target.style.height = `${e.target.scrollHeight}px`
					}}
					onBlur={handleSystemPromptBlur}
					placeholder="Instructions for the agent..."
					className="min-h-[120px] font-mono text-sm w-full rounded-md border border-input bg-background px-3 py-2 text-base ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 md:text-sm resize-none overflow-hidden"
					ref={(el) => {
						if (el) {
							el.style.height = 'auto'
							el.style.height = `${el.scrollHeight}px`
						}
					}}
				/>
			</Section>

			{/* LLM Configuration */}
			<Section title="LLM Configuration">
				<div className="flex gap-3">
					<div className="flex-1">
						<Label>Provider</Label>
						<Select value={llmProvider} onValueChange={handleProviderChange}>
							<SelectTrigger>
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="anthropic">Anthropic</SelectItem>
								<SelectItem value="openai">OpenAI</SelectItem>
							</SelectContent>
						</Select>
					</div>
					<div className="flex-1">
						<Label>Model</Label>
						<Input
							type="text"
							value={modelDraft}
							onChange={(e) => setModelDraft(e.target.value)}
							onBlur={handleModelBlur}
							placeholder="e.g. claude-sonnet-4-5-20250514"
						/>
					</div>
				</div>
			</Section>

			{/* MCP Servers */}
			<Section title="MCP Servers">
				<McpServers tools={agent?.tools ?? {}} onUpdate={handleToolsUpdate} />
			</Section>

			{isPending && <p className="text-xs text-muted-foreground">Creating...</p>}

			{error && (
				<div className="rounded bg-error/10 px-3 py-2 text-sm text-error">
					{error.message || 'Failed to create agent'}
				</div>
			)}
		</div>
	)
}

function Section({
	title,
	children,
}: {
	title: string
	children: React.ReactNode
}) {
	return (
		<div className="mb-6">
			<h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground mb-2">
				{title}
			</h3>
			{children}
		</div>
	)
}
