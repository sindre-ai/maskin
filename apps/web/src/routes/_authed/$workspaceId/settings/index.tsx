import { PageHeader } from '@/components/layout/page-header'
import { McpConnectionSection } from '@/components/settings/mcp-connection'
import { RouteError } from '@/components/shared/route-error'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useUpdateWorkspace } from '@/hooks/use-workspaces'
import { api } from '@/lib/api'
import { getApiKey } from '@/lib/auth'
import { getCredentialsCommand, parseClaudeCredentials } from '@/lib/claude-oauth'
import { cn } from '@/lib/cn'
import { queryKeys } from '@/lib/query-keys'
import { type Theme, useTheme } from '@/lib/theme'
import { useWorkspace } from '@/lib/workspace-context'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, createFileRoute } from '@tanstack/react-router'
import {
	Check,
	Copy,
	ExternalLink,
	Eye,
	EyeOff,
	Monitor,
	Moon,
	Sun,
	Unplug,
	Zap,
} from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'

export const Route = createFileRoute('/_authed/$workspaceId/settings/')({
	component: SettingsPage,
	errorComponent: ({ error }) => <RouteError error={error} />,
})

function SettingsPage() {
	const { workspace, workspaceId } = useWorkspace()
	const updateWorkspace = useUpdateWorkspace(workspaceId)
	const [name, setName] = useState(workspace.name)

	const handleSave = () => {
		if (name !== workspace.name) {
			updateWorkspace.mutate({ name })
		}
	}

	return (
		<div>
			<PageHeader title="Settings" />

			<div className="max-w-lg space-y-6">
				<div>
					<Label className="mb-1 text-muted-foreground">Workspace name</Label>
					<div className="flex gap-2">
						<Input
							type="text"
							value={name}
							onChange={(e) => setName(e.target.value)}
							className="flex-1"
						/>
						<Button
							onClick={handleSave}
							disabled={name === workspace.name || updateWorkspace.isPending}
						>
							Save
						</Button>
					</div>
				</div>

				<div className="border-t border-border pt-6">
					<ClaudeOAuthSection workspaceId={workspaceId} />
				</div>

				<div className="border-t border-border pt-6">
					<LLMKeysEditor workspace={workspace} workspaceId={workspaceId} />
				</div>

				<div className="border-t border-border pt-6">
					<ThemePicker />
				</div>

				<div className="border-t border-border pt-6">
					<ApiKeySection />
				</div>

				<div className="border-t border-border pt-6">
					<RelationshipTypesEditor workspace={workspace} workspaceId={workspaceId} />
				</div>

				<div className="border-t border-border pt-6">
					<McpConnectionSection workspaceId={workspaceId} />
				</div>

				<div className="border-t border-border pt-6 space-y-2">
					<Link
						to="/$workspaceId/settings/properties"
						params={{ workspaceId }}
						search={{ create: false }}
						className="block rounded-lg border border-border bg-card p-4 hover:border-border transition-colors"
					>
						<p className="text-sm font-medium text-foreground">Properties</p>
						<p className="text-xs text-muted-foreground mt-1">
							Define custom fields for your objects
						</p>
					</Link>
					<Link
						to="/$workspaceId/settings/triggers"
						params={{ workspaceId }}
						search={{ create: false }}
						className="block rounded-lg border border-border bg-card p-4 hover:border-border transition-colors"
					>
						<p className="text-sm font-medium text-foreground">Triggers</p>
						<p className="text-xs text-muted-foreground mt-1">Manage automation triggers</p>
					</Link>
					<Link
						to="/$workspaceId/settings/members"
						params={{ workspaceId }}
						search={{ create: false }}
						className="block rounded-lg border border-border bg-card p-4 hover:border-border transition-colors"
					>
						<p className="text-sm font-medium text-foreground">Members</p>
						<p className="text-xs text-muted-foreground mt-1">
							Manage workspace members and agents
						</p>
					</Link>
					<Link
						to="/$workspaceId/settings/integrations"
						params={{ workspaceId }}
						className="block rounded-lg border border-border bg-card p-4 hover:border-border transition-colors"
					>
						<p className="text-sm font-medium text-foreground">Integrations</p>
						<p className="text-xs text-muted-foreground mt-1">
							Connect external services like GitHub
						</p>
					</Link>
				</div>
			</div>
		</div>
	)
}

function ClaudeOAuthSection({ workspaceId }: { workspaceId: string }) {
	const queryClient = useQueryClient()
	const [mode, setMode] = useState<'idle' | 'browser' | 'paste'>('idle')
	const [pasteValue, setPasteValue] = useState('')
	const [flowId, setFlowId] = useState<string | null>(null)
	const [parseError, setParseError] = useState('')

	const invalidate = useCallback(
		() => queryClient.invalidateQueries({ queryKey: queryKeys.claudeOauth.status(workspaceId) }),
		[queryClient, workspaceId],
	)

	const statusQuery = useQuery({
		queryKey: queryKeys.claudeOauth.status(workspaceId),
		queryFn: () => api.claudeOauth.status(workspaceId),
	})

	// Poll flow status when browser login is in progress
	const flowQuery = useQuery({
		queryKey: ['claude-oauth', 'flow', flowId],
		queryFn: () => (flowId ? api.claudeOauth.flowStatus(flowId) : Promise.reject()),
		enabled: mode === 'browser' && !!flowId,
		refetchInterval: (query) => {
			const s = query.state.data?.status
			if (s === 'complete' || s === 'error') return false
			return 1500
		},
	})

	useEffect(() => {
		if (flowQuery.data?.status === 'complete' && mode === 'browser') {
			setMode('idle')
			setFlowId(null)
			invalidate()
		}
	}, [flowQuery.data?.status, mode, invalidate])

	const importMutation = useMutation({
		mutationFn: (tokens: import('@/lib/api').ClaudeOAuthImportInput) =>
			api.claudeOauth.import(workspaceId, tokens),
		onSuccess: () => {
			setPasteValue('')
			setMode('idle')
			invalidate()
		},
	})

	const disconnectMutation = useMutation({
		mutationFn: () => api.claudeOauth.disconnect(workspaceId),
		onSuccess: invalidate,
	})

	const handleBrowserLogin = async () => {
		setMode('browser')
		try {
			const { auth_url, flow_id } = await api.claudeOauth.start(workspaceId)
			setFlowId(flow_id)
			window.open(auth_url, '_blank', 'width=600,height=700,popup=yes')
		} catch {
			setMode('idle')
		}
	}

	const handlePasteImport = () => {
		setParseError('')
		const parsed = parseClaudeCredentials(pasteValue)
		if (!parsed) {
			setParseError('Could not find Claude OAuth tokens in the pasted JSON.')
			return
		}
		importMutation.mutate(parsed)
	}

	const status = statusQuery.data
	const isConnected = status?.connected && status?.valid

	const formatExpiry = (expiresAt?: number) => {
		if (!expiresAt) return ''
		const remaining = expiresAt - Date.now()
		if (remaining <= 0) return 'expired'
		const hours = Math.floor(remaining / (1000 * 60 * 60))
		if (hours > 24) return `${Math.floor(hours / 24)}d`
		if (hours > 0) return `${hours}h`
		return `${Math.floor(remaining / (1000 * 60))}m`
	}

	return (
		<div>
			<Label className="mb-1 text-muted-foreground">Claude Subscription</Label>
			<p className="text-xs text-muted-foreground mb-3">
				Connect your Claude Pro/Max/Teams subscription to use it for agent sessions instead of an
				API key.
			</p>

			{isConnected ? (
				<div className="rounded-lg border border-border bg-bg-surface p-3 space-y-2">
					<div className="flex items-center justify-between">
						<div className="flex items-center gap-2">
							<div className="size-2 rounded-full bg-success" />
							<span className="text-sm font-medium text-foreground">Connected</span>
							{status?.subscription_type && (
								<span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
									{status.subscription_type}
								</span>
							)}
							{status?.expires_at && (
								<span className="text-xs text-muted-foreground">
									expires in {formatExpiry(status.expires_at)}
								</span>
							)}
						</div>
						<Button
							variant="outline"
							size="sm"
							onClick={() => disconnectMutation.mutate()}
							disabled={disconnectMutation.isPending}
						>
							<Unplug size={14} className="mr-1" />
							Disconnect
						</Button>
					</div>
				</div>
			) : status?.connected && !status?.valid ? (
				<div className="rounded-lg border border-warning/30 bg-warning/5 p-3 space-y-2">
					<div className="flex items-center gap-2 text-sm text-warning">
						<span>Credentials expired</span>
					</div>
					<div className="flex gap-2">
						<Button variant="outline" size="sm" onClick={handleBrowserLogin}>
							<Zap size={14} className="mr-1" />
							Reconnect
						</Button>
						<Button
							variant="ghost"
							size="sm"
							onClick={() => disconnectMutation.mutate()}
							disabled={disconnectMutation.isPending}
						>
							<Unplug size={14} className="mr-1" />
							Remove
						</Button>
					</div>
				</div>
			) : mode === 'browser' ? (
				<div className="space-y-3">
					<div className="rounded-lg border border-border bg-bg-surface p-3">
						<div className="flex items-center gap-2 mb-1">
							<div className="size-2 rounded-full bg-accent animate-pulse" />
							<span className="text-sm font-medium">Waiting for login...</span>
						</div>
						<p className="text-xs text-muted-foreground">
							A browser window opened for you to sign in to Claude. Complete the login there, then
							this will update automatically.
						</p>
						{flowQuery.data?.status === 'error' && (
							<p className="text-xs text-error mt-2">{flowQuery.data.error || 'Login failed'}</p>
						)}
					</div>
					<button
						type="button"
						className="text-xs text-muted-foreground hover:text-foreground"
						onClick={() => {
							setMode('idle')
							setFlowId(null)
						}}
					>
						Cancel
					</button>
				</div>
			) : mode === 'paste' ? (
				<div className="space-y-3">
					<p className="text-xs text-muted-foreground">
						Run this in your terminal, then paste the output below:
					</p>
					<code className="block rounded-md border border-border bg-muted px-3 py-2 text-xs font-mono select-all">
						{getCredentialsCommand()}
					</code>
					<textarea
						value={pasteValue}
						onChange={(e) => setPasteValue(e.target.value)}
						placeholder="Paste the contents of .credentials.json here..."
						className="w-full rounded-md border border-border bg-background px-3 py-2 text-xs font-mono min-h-[80px] resize-y focus:outline-none focus:ring-1 focus:ring-accent"
					/>
					{(parseError || importMutation.isError) && (
						<p className="text-xs text-error">
							{parseError || importMutation.error?.message || 'Import failed'}
						</p>
					)}
					<div className="flex gap-2">
						<Button
							onClick={handlePasteImport}
							disabled={!pasteValue.trim() || importMutation.isPending}
							size="sm"
						>
							{importMutation.isPending ? 'Importing...' : 'Import'}
						</Button>
						<button
							type="button"
							className="text-xs text-muted-foreground hover:text-foreground"
							onClick={() => {
								setMode('idle')
								setPasteValue('')
								setParseError('')
							}}
						>
							Cancel
						</button>
					</div>
				</div>
			) : (
				<div className="flex gap-2">
					<Button variant="outline" onClick={handleBrowserLogin}>
						<ExternalLink size={14} className="mr-1.5" />
						Log in with Claude
					</Button>
					<Button
						variant="ghost"
						onClick={() => setMode('paste')}
						className="text-muted-foreground"
					>
						Import credentials
					</Button>
				</div>
			)}
		</div>
	)
}

const llmProviders = [
	{ key: 'anthropic' as const, label: 'Anthropic', placeholder: 'sk-ant-...' },
	{ key: 'openai' as const, label: 'OpenAI', placeholder: 'sk-...' },
]

function LLMKeysEditor({
	workspace,
	workspaceId,
}: {
	workspace: import('@/lib/api').WorkspaceWithRole
	workspaceId: string
}) {
	const updateWorkspace = useUpdateWorkspace(workspaceId)
	const settings = workspace.settings as Record<string, unknown>
	const savedKeys = (settings?.llm_keys as Record<string, string>) ?? {}

	const [keys, setKeys] = useState<Record<string, string>>({
		anthropic: savedKeys.anthropic ?? '',
		openai: savedKeys.openai ?? '',
	})
	const [visible, setVisible] = useState<Record<string, boolean>>({})

	const handleSave = (provider: string) => {
		const value = keys[provider]?.trim()
		const updatedKeys = { ...savedKeys }
		if (value) {
			updatedKeys[provider] = value
		} else {
			delete updatedKeys[provider]
		}
		updateWorkspace.mutate({
			settings: { ...settings, llm_keys: updatedKeys },
		})
	}

	const isDirty = (provider: string) => {
		const saved = savedKeys[provider] ?? ''
		return keys[provider] !== saved
	}

	return (
		<div>
			<Label className="mb-1 text-muted-foreground">LLM API Keys</Label>
			<p className="text-xs text-muted-foreground mb-3">
				Set API keys per provider. All agents in this workspace will use these keys.
			</p>
			<div className="space-y-3">
				{llmProviders.map((provider) => (
					<div key={provider.key}>
						<Label className="mb-1 text-xs text-muted-foreground">{provider.label}</Label>
						<div className="flex gap-2">
							<div className="relative flex-1">
								<Input
									type={visible[provider.key] ? 'text' : 'password'}
									value={keys[provider.key]}
									onChange={(e) => setKeys((prev) => ({ ...prev, [provider.key]: e.target.value }))}
									placeholder={provider.placeholder}
									className="pr-9"
								/>
								<button
									type="button"
									className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
									onClick={() =>
										setVisible((prev) => ({
											...prev,
											[provider.key]: !prev[provider.key],
										}))
									}
								>
									{visible[provider.key] ? <EyeOff size={14} /> : <Eye size={14} />}
								</button>
							</div>
							<Button
								onClick={() => handleSave(provider.key)}
								disabled={!isDirty(provider.key) || updateWorkspace.isPending}
							>
								Save
							</Button>
						</div>
					</div>
				))}
			</div>
		</div>
	)
}

function RelationshipTypesEditor({
	workspace,
	workspaceId,
}: {
	workspace: import('@/lib/api').WorkspaceWithRole
	workspaceId: string
}) {
	const updateWorkspace = useUpdateWorkspace(workspaceId)
	const [newType, setNewType] = useState('')

	const settings = workspace.settings as Record<string, unknown>
	const relationshipTypes = (settings?.relationship_types as string[] | undefined) ?? [
		'informs',
		'breaks_into',
		'blocks',
		'relates_to',
		'duplicates',
	]

	const handleAdd = () => {
		const trimmed = newType.trim().toLowerCase().replace(/\s+/g, '_')
		if (!trimmed || relationshipTypes.includes(trimmed)) return
		const updated = [...relationshipTypes, trimmed]
		updateWorkspace.mutate({
			settings: { ...settings, relationship_types: updated },
		})
		setNewType('')
	}

	const handleRemove = (type: string) => {
		const updated = relationshipTypes.filter((t) => t !== type)
		updateWorkspace.mutate({
			settings: { ...settings, relationship_types: updated },
		})
	}

	return (
		<div>
			<Label className="mb-2 text-muted-foreground">Relationship types</Label>
			<div className="flex flex-wrap gap-1.5 mb-2">
				{relationshipTypes.map((type) => (
					<span
						key={type}
						className="inline-flex items-center gap-1 rounded-full bg-muted px-2.5 py-1 text-xs text-muted-foreground"
					>
						{type.replace(/_/g, ' ')}
						<button
							type="button"
							className="text-muted-foreground hover:text-error ml-0.5"
							onClick={() => handleRemove(type)}
							title={`Remove ${type}`}
						>
							×
						</button>
					</span>
				))}
			</div>
			<div className="flex gap-2">
				<Input
					type="text"
					value={newType}
					onChange={(e) => setNewType(e.target.value)}
					onKeyDown={(e) => e.key === 'Enter' && handleAdd()}
					placeholder="New relationship type"
					className="flex-1"
				/>
				<Button
					variant="secondary"
					onClick={handleAdd}
					disabled={!newType.trim() || updateWorkspace.isPending}
				>
					Add
				</Button>
			</div>
		</div>
	)
}

function ApiKeySection() {
	const apiKey = getApiKey()
	const [copied, setCopied] = useState(false)

	const handleCopy = async () => {
		if (!apiKey) return
		await navigator.clipboard.writeText(apiKey)
		setCopied(true)
		setTimeout(() => setCopied(false), 2000)
	}

	if (!apiKey) return null

	return (
		<div>
			<Label className="mb-1 text-muted-foreground">API key</Label>
			<div className="flex items-center gap-2">
				<code className="flex-1 rounded-md border border-border bg-muted px-3 py-2 text-sm font-mono truncate select-all">
					{apiKey}
				</code>
				<Button variant="outline" size="icon" onClick={handleCopy}>
					{copied ? <Check size={16} /> : <Copy size={16} />}
				</Button>
			</div>
		</div>
	)
}

const themeOptions: { value: Theme; label: string; icon: typeof Sun }[] = [
	{ value: 'light', label: 'Light', icon: Sun },
	{ value: 'dark', label: 'Dark', icon: Moon },
	{ value: 'system', label: 'System', icon: Monitor },
]

function ThemePicker() {
	const { theme, setTheme } = useTheme()

	return (
		<div>
			<Label className="mb-2 text-muted-foreground">Appearance</Label>
			<div className="flex gap-1 rounded-lg border border-border bg-background p-1">
				{themeOptions.map((option) => {
					const Icon = option.icon
					const isActive = theme === option.value
					return (
						<button
							key={option.value}
							type="button"
							onClick={() => setTheme(option.value)}
							className={cn(
								'flex flex-1 items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-sm transition-colors',
								isActive
									? 'bg-muted text-foreground font-medium shadow-sm'
									: 'text-muted-foreground hover:text-muted-foreground',
							)}
						>
							<Icon size={14} />
							{option.label}
						</button>
					)
				})}
			</div>
		</div>
	)
}
