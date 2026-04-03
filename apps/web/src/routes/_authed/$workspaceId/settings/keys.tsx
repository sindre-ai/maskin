import { RouteError } from '@/components/shared/route-error'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useUpdateWorkspace } from '@/hooks/use-workspaces'
import { api } from '@/lib/api'
import { getCredentialsCommand, parseClaudeCredentials } from '@/lib/claude-oauth'
import { queryKeys } from '@/lib/query-keys'
import { useWorkspace } from '@/lib/workspace-context'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { Eye, EyeOff, Unplug } from 'lucide-react'
import { useCallback, useState } from 'react'

export const Route = createFileRoute('/_authed/$workspaceId/settings/keys')({
	component: KeysPage,
	errorComponent: ({ error }) => <RouteError error={error} />,
})

function KeysPage() {
	const { workspace, workspaceId } = useWorkspace()

	return (
		<div className="max-w-lg space-y-6">
			<ClaudeOAuthSection workspaceId={workspaceId} />

			<div className="border-t border-border pt-6">
				<LLMKeysEditor workspace={workspace} workspaceId={workspaceId} />
			</div>
		</div>
	)
}

function ClaudeOAuthSection({ workspaceId }: { workspaceId: string }) {
	const queryClient = useQueryClient()
	const [mode, setMode] = useState<'idle' | 'paste'>('idle')
	const [pasteValue, setPasteValue] = useState('')
	const [parseError, setParseError] = useState('')

	const invalidate = useCallback(
		() => queryClient.invalidateQueries({ queryKey: queryKeys.claudeOauth.status(workspaceId) }),
		[queryClient, workspaceId],
	)

	const statusQuery = useQuery({
		queryKey: queryKeys.claudeOauth.status(workspaceId),
		queryFn: () => api.claudeOauth.status(workspaceId),
	})

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
						<Button variant="outline" size="sm" onClick={() => setMode('paste')}>
							Import credentials
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
						className="w-full rounded-md border border-border bg-background px-3 py-2 text-xs font-mono min-h-[80px] resize-y focus:outline-none focus:ring-1 focus:ring-ring"
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
				<Button variant="outline" onClick={() => setMode('paste')}>
					Import credentials
				</Button>
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
