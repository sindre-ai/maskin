import { FormError } from '@/components/shared/form-error'
import { Button } from '@/components/ui/button'
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { useCreateActor } from '@/hooks/use-actors'
import { ApiError, api } from '@/lib/api'
import { queryKeys } from '@/lib/query-keys'
import { useQueryClient } from '@tanstack/react-query'
import { useMemo, useState } from 'react'

const PROVIDER_MODELS: Record<string, { label: string; value: string }[]> = {
	anthropic: [
		{ label: 'Claude Opus 4.6', value: 'claude-opus-4-6' },
		{ label: 'Claude Sonnet 4.6', value: 'claude-sonnet-4-6' },
		{ label: 'Claude Haiku 4.5', value: 'claude-haiku-4-5' },
		{ label: 'Claude Sonnet 4.5', value: 'claude-sonnet-4-5' },
		{ label: 'Claude Sonnet 4', value: 'claude-sonnet-4-0' },
		{ label: 'Claude Opus 4', value: 'claude-opus-4-0' },
	],
	openai: [
		{ label: 'GPT-5.4', value: 'gpt-5.4' },
		{ label: 'GPT-5.4 Mini', value: 'gpt-5.4-mini' },
		{ label: 'GPT-5.4 Nano', value: 'gpt-5.4-nano' },
		{ label: 'o3', value: 'o3' },
		{ label: 'o4 Mini', value: 'o4-mini' },
		{ label: 'GPT-4o', value: 'gpt-4o' },
		{ label: 'GPT-4o Mini', value: 'gpt-4o-mini' },
	],
	ollama: [
		{ label: 'Llama 3.1', value: 'llama3.1' },
		{ label: 'Llama 3.2', value: 'llama3.2' },
		{ label: 'DeepSeek R1', value: 'deepseek-r1' },
		{ label: 'Gemma 3', value: 'gemma3' },
		{ label: 'Qwen 3', value: 'qwen3' },
		{ label: 'Qwen 3.5', value: 'qwen3.5' },
		{ label: 'Mistral', value: 'mistral' },
	],
}

interface CreateAgentDialogViewProps {
	open: boolean
	onClose: () => void
	onSubmit: (data: {
		name: string
		systemPrompt?: string
		llmProvider?: string
		llmConfig?: Record<string, unknown>
	}) => Promise<{ api_key: string }>
	isPending?: boolean
	error?: Error | null
}

export function CreateAgentDialogView({
	open,
	onClose,
	onSubmit,
	isPending = false,
	error = null,
}: CreateAgentDialogViewProps) {
	const [name, setName] = useState('')
	const [systemPrompt, setSystemPrompt] = useState('')
	const [llmProvider, setLlmProvider] = useState('anthropic')
	const [modelName, setModelName] = useState('')
	const models = useMemo(() => PROVIDER_MODELS[llmProvider] ?? [], [llmProvider])

	const handleProviderChange = (value: string) => {
		setLlmProvider(value)
		setModelName('')
	}
	const [createdApiKey, setCreatedApiKey] = useState<string | null>(null)
	const [copied, setCopied] = useState(false)

	const fieldErrors = error instanceof ApiError ? error.fieldErrors : {}

	const handleSubmit = async (e: React.FormEvent) => {
		e.preventDefault()
		if (!name.trim()) return
		try {
			const result = await onSubmit({
				name: name.trim(),
				systemPrompt: systemPrompt.trim() || undefined,
				llmProvider: llmProvider || undefined,
				llmConfig: modelName ? { model: modelName } : undefined,
			})
			setCreatedApiKey(result.api_key)
		} catch {
			// error accessible via error prop
		}
	}

	const handleCopy = async () => {
		if (createdApiKey) {
			await navigator.clipboard.writeText(createdApiKey)
			setCopied(true)
			setTimeout(() => setCopied(false), 2000)
		}
	}

	const handleClose = () => {
		setName('')
		setSystemPrompt('')
		setLlmProvider('anthropic')
		setModelName('')
		setCreatedApiKey(null)
		setCopied(false)
		onClose()
	}

	return (
		<Dialog open={open} onOpenChange={(v) => !v && handleClose()}>
			<DialogContent className="sm:max-w-md">
				{createdApiKey ? (
					<>
						<DialogHeader>
							<DialogTitle>Agent Created</DialogTitle>
							<DialogDescription>
								Save this API key now — it cannot be retrieved later.
							</DialogDescription>
						</DialogHeader>
						<div className="space-y-3">
							<div className="flex items-center gap-2">
								<code className="flex-1 rounded border border-border bg-background px-3 py-2 text-xs font-mono text-foreground break-all">
									{createdApiKey}
								</code>
								<Button size="sm" onClick={handleCopy}>
									{copied ? 'Copied!' : 'Copy'}
								</Button>
							</div>
							<div className="flex justify-end">
								<Button variant="secondary" onClick={handleClose}>
									Done
								</Button>
							</div>
						</div>
					</>
				) : (
					<>
						<DialogHeader>
							<DialogTitle>Create Agent</DialogTitle>
							<DialogDescription>Create a new AI agent for this workspace.</DialogDescription>
						</DialogHeader>
						<form onSubmit={handleSubmit} className="space-y-3">
							<div>
								<Label className="mb-1 text-muted-foreground">Name</Label>
								<Input
									type="text"
									value={name}
									onChange={(e) => setName(e.target.value)}
									placeholder="Agent name"
									autoFocus
								/>
								<FormError error={fieldErrors.name} />
							</div>
							<div>
								<Label className="mb-1 text-muted-foreground">System Prompt</Label>
								<Textarea
									value={systemPrompt}
									onChange={(e) => setSystemPrompt(e.target.value)}
									placeholder="Instructions for the agent..."
								/>
								<FormError error={fieldErrors.system_prompt} />
							</div>
							<div className="flex gap-2">
								<div className="flex-1">
									<Label className="mb-1 text-muted-foreground">LLM Provider</Label>
									<Select value={llmProvider} onValueChange={handleProviderChange}>
										<SelectTrigger>
											<SelectValue />
										</SelectTrigger>
										<SelectContent>
											<SelectItem value="anthropic">Anthropic</SelectItem>
											<SelectItem value="openai">OpenAI</SelectItem>
											<SelectItem value="ollama">Ollama</SelectItem>
										</SelectContent>
									</Select>
									<FormError error={fieldErrors.llm_provider} />
								</div>
								<div className="flex-1">
									<Label className="mb-1 text-muted-foreground">Model</Label>
									<Select value={modelName} onValueChange={setModelName}>
										<SelectTrigger>
											<SelectValue placeholder="Select model" />
										</SelectTrigger>
										<SelectContent>
											{models.map((m) => (
												<SelectItem key={m.value} value={m.value}>
													{m.label}
												</SelectItem>
											))}
										</SelectContent>
									</Select>
								</div>
							</div>
							{error && !(error instanceof ApiError && error.hasFieldErrors()) && (
								<div className="rounded bg-error/10 px-3 py-2 text-sm text-error">
									{error.message || 'Failed to create agent'}
								</div>
							)}
							<div className="flex justify-end gap-2">
								<Button type="button" variant="ghost" onClick={handleClose}>
									Cancel
								</Button>
								<Button type="submit" disabled={!name.trim() || isPending}>
									{isPending ? 'Creating...' : 'Create'}
								</Button>
							</div>
						</form>
					</>
				)}
			</DialogContent>
		</Dialog>
	)
}

interface CreateAgentDialogProps {
	open: boolean
	onClose: () => void
	workspaceId: string
}

export function CreateAgentDialog({ open, onClose, workspaceId }: CreateAgentDialogProps) {
	const createActor = useCreateActor(workspaceId)
	const queryClient = useQueryClient()

	const handleSubmit = async (data: {
		name: string
		systemPrompt?: string
		llmProvider?: string
		llmConfig?: Record<string, unknown>
	}) => {
		const result = await createActor.mutateAsync({
			type: 'agent',
			name: data.name,
			system_prompt: data.systemPrompt,
			llm_provider: data.llmProvider,
			llm_config: data.llmConfig,
		})
		// Auto-add agent to workspace, then invalidate so the list updates
		try {
			await api.workspaces.members.add(workspaceId, {
				actor_id: result.id,
				role: 'member',
			})
		} catch {
			// workspace membership may already exist
		}
		await queryClient.invalidateQueries({ queryKey: queryKeys.actors.all(workspaceId) })
		return result
	}

	return (
		<CreateAgentDialogView
			open={open}
			onClose={onClose}
			onSubmit={handleSubmit}
			isPending={createActor.isPending}
			error={createActor.error}
		/>
	)
}
