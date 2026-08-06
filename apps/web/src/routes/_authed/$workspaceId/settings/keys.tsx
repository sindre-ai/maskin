import { BillingSection } from '@/components/settings/billing-section'
import { RouteError } from '@/components/shared/route-error'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Switch } from '@/components/ui/switch'
import { useUpdateWorkspace } from '@/hooks/use-workspaces'
import {
	type ClaudeOAuthImportInput,
	type ClaudeOAuthSlot,
	type ClaudeOAuthSlotInfo,
	api,
} from '@/lib/api'
import { getCredentialsCommand, parseClaudeCredentials } from '@/lib/claude-oauth'
import { cn } from '@/lib/cn'
import { queryKeys } from '@/lib/query-keys'
import { useWorkspace } from '@/lib/workspace-context'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { ChevronDown, ChevronRight, Eye, EyeOff, Unplug } from 'lucide-react'
import { useCallback, useState } from 'react'

export const Route = createFileRoute('/_authed/$workspaceId/settings/keys')({
	component: KeysPage,
	errorComponent: ({ error }) => <RouteError error={error} />,
})

function KeysPage() {
	const { workspace, workspaceId } = useWorkspace()
	const byollmAllowed = Boolean(workspace.byollmAllowed)

	return (
		<div className="max-w-lg space-y-6">
			<BillingSection workspaceId={workspaceId} byollmAllowed={byollmAllowed} />

			{byollmAllowed ? (
				<>
					<div className="border-t border-border pt-6">
						<ClaudeOAuthSection workspaceId={workspaceId} />
					</div>

					<div className="border-t border-border pt-6">
						<LLMKeysEditor workspace={workspace} workspaceId={workspaceId} />
					</div>

					<div className="border-t border-border pt-6">
						<CustomLlmEditor workspace={workspace} workspaceId={workspaceId} />
					</div>
				</>
			) : (
				<div className="border-t border-border pt-6" data-testid="byollm-disabled-notice">
					<Label className="mb-1 text-bold">Claude Subscription & API Keys</Label>
					<p className="text-xs text-muted-foreground">
						This workspace uses the Maskin-provided LLM plan. Bringing your own Claude subscription,
						API key, or custom endpoint isn't available here.
					</p>
				</div>
			)}
		</div>
	)
}

// Map a classified failover reason (written by the classifier in T4/T6) to
// the customer-facing line shown next to the unhealthy primary. Reasons
// outside this map render generically rather than leaking raw codes.
const FAILOVER_REASON_COPY: Record<string, { slotLine: string; bannerBody: string }> = {
	auth_failed: {
		slotLine: 'Authentication failed. Reconnect to use this subscription again.',
		bannerBody:
			'The primary subscription needs to be reconnected. Agents are running on the backup until then.',
	},
	token_expired: {
		slotLine: 'Credentials expired. Reconnect to use this subscription again.',
		bannerBody:
			'The primary subscription needs to be reconnected. Agents are running on the backup until then.',
	},
	quota_exhausted_5h: {
		slotLine: '5-hour usage limit reached.',
		bannerBody:
			'The primary hit its 5-hour usage limit. Agents are running on the backup until the primary resets.',
	},
	quota_exhausted_weekly: {
		slotLine: 'Weekly usage limit reached.',
		bannerBody:
			'The primary hit its weekly usage limit. Agents are running on the backup until the primary resets.',
	},
	quota_exhausted: {
		slotLine: 'Usage limit reached.',
		bannerBody:
			'The primary hit a usage limit. Agents are running on the backup until it recovers.',
	},
}

function formatExpiry(expiresAt: number | undefined): string {
	if (!expiresAt) return ''
	const remaining = expiresAt - Date.now()
	if (remaining <= 0) return 'expired'
	const hours = Math.floor(remaining / (1000 * 60 * 60))
	if (hours > 24) return `${Math.floor(hours / 24)}d`
	if (hours > 0) return `${hours}h`
	return `${Math.floor(remaining / (1000 * 60))}m`
}

function ClaudeOAuthSection({ workspaceId }: { workspaceId: string }) {
	const queryClient = useQueryClient()
	const [pasteSlot, setPasteSlot] = useState<ClaudeOAuthSlot | null>(null)

	const invalidate = useCallback(
		() => queryClient.invalidateQueries({ queryKey: queryKeys.claudeOauth.status(workspaceId) }),
		[queryClient, workspaceId],
	)

	const statusQuery = useQuery({
		queryKey: queryKeys.claudeOauth.status(workspaceId),
		queryFn: () => api.claudeOauth.status(workspaceId),
	})

	const status = statusQuery.data
	const slots = status?.slots ?? {}
	const isFailedOver = Boolean(
		status?.connected &&
			status.active_slot === 'backup' &&
			slots.primary &&
			status.last_classified_reason,
	)
	const reasonCopy = status?.last_classified_reason
		? FAILOVER_REASON_COPY[status.last_classified_reason]
		: undefined

	const closePaste = useCallback(() => setPasteSlot(null), [])

	return (
		<div>
			<div>
				<Label className="mb-1 text-bold">Default LLM ($5 Free Usage)</Label>
				<p className="text-xs text-muted-foreground mb-6">
					Uses Deepseek V4 Flash via OpenRouter as the default model when no API keys are
					configured. <b>Provides up to $5 USD equivalent of free usage per day, per workspace.</b>
					Automatically activates for users without Claude subscriptions, API keys or custom llm.
				</p>
			</div>
			<Label className="mb-1 text-bold">Claude Subscription</Label>
			<p className="text-xs text-muted-foreground mb-3">
				Connect your Claude Pro/Max/Teams subscription to use it for agent sessions instead of an
				API key. Add a backup so agents keep working if the primary hits a usage limit or its
				credentials expire.
			</p>

			{isFailedOver && reasonCopy && (
				<FailoverBanner reasonCopy={reasonCopy} reasonCode={status?.last_classified_reason ?? ''} />
			)}

			<div className="grid grid-cols-1 md:grid-cols-2 gap-3" data-testid="claude-oauth-slots">
				<SlotCard
					slot="primary"
					info={slots.primary}
					activeSlot={status?.active_slot ?? 'primary'}
					connected={Boolean(status?.connected)}
					unhealthyReasonLine={
						isFailedOver ? (reasonCopy?.slotLine ?? 'Primary subscription is unhealthy.') : null
					}
					workspaceId={workspaceId}
					onConnectClick={() => setPasteSlot('primary')}
					onSuccess={invalidate}
					hasOtherSlot={Boolean(slots.backup)}
				/>
				<SlotCard
					slot="backup"
					info={slots.backup}
					activeSlot={status?.active_slot ?? 'primary'}
					connected={Boolean(status?.connected)}
					unhealthyReasonLine={null}
					workspaceId={workspaceId}
					onConnectClick={() => setPasteSlot('backup')}
					onSuccess={invalidate}
					hasOtherSlot={Boolean(slots.primary)}
				/>
			</div>

			{pasteSlot && (
				<PasteFlow
					workspaceId={workspaceId}
					initialSlot={pasteSlot}
					onClose={closePaste}
					onSuccess={invalidate}
				/>
			)}
		</div>
	)
}

interface SlotCardProps {
	slot: ClaudeOAuthSlot
	info: ClaudeOAuthSlotInfo | undefined
	activeSlot: ClaudeOAuthSlot
	connected: boolean
	unhealthyReasonLine: string | null
	workspaceId: string
	onConnectClick: () => void
	onSuccess: () => void
	hasOtherSlot: boolean
}

function SlotCard({
	slot,
	info,
	activeSlot,
	connected,
	unhealthyReasonLine,
	workspaceId,
	onConnectClick,
	onSuccess,
	hasOtherSlot,
}: SlotCardProps) {
	const disconnectMutation = useMutation({
		mutationFn: () => api.claudeOauth.disconnect(workspaceId, slot),
		onSuccess,
	})

	const swapMutation = useMutation({
		mutationFn: () => api.claudeOauth.swap(workspaceId),
		onSuccess,
	})

	const label = slot === 'primary' ? 'Primary' : 'Backup'
	const isActive = connected && activeSlot === slot && Boolean(info)
	const isUnhealthy = slot === 'primary' && Boolean(unhealthyReasonLine)

	if (!info) {
		// Empty state — only the backup slot can be in this state when a
		// primary is connected (the dashed "Add a backup" card). An empty
		// primary slot also lands here (e.g. legacy disconnect path) and we
		// use slot-appropriate copy.
		const isBackup = slot === 'backup'
		return (
			<div
				className="rounded-lg border border-dashed border-border bg-transparent p-3 space-y-2"
				data-slot={slot}
				data-testid={`slot-${slot}`}
			>
				<div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
					{label}
				</div>
				<div className="text-sm font-medium text-muted-foreground">
					{isBackup ? 'Add a backup' : 'No primary connected'}
				</div>
				<p className="text-xs text-muted-foreground leading-snug">
					{isBackup
						? 'If your primary hits its usage limit or its credentials expire, agents stop until you reconnect. A backup keeps them running.'
						: 'Connect your Claude subscription to start running agent sessions.'}
				</p>
				<Button variant="outline" size="sm" onClick={onConnectClick}>
					{isBackup ? 'Import backup credentials' : 'Import credentials'}
				</Button>
			</div>
		)
	}

	return (
		<div
			className="rounded-lg border border-border bg-bg-surface p-3 space-y-2"
			data-slot={slot}
			data-testid={`slot-${slot}`}
		>
			<div className="flex items-center justify-between gap-2">
				<span className="text-xs font-semibold uppercase tracking-wide text-foreground">
					{label}
				</span>
				{isActive && (
					<span
						className="inline-flex items-center rounded-full bg-success/15 text-success px-2 py-0.5 text-[11px] font-medium"
						aria-label="Currently serving sessions"
					>
						In use
					</span>
				)}
			</div>
			<div className="flex items-center gap-2 flex-wrap">
				<div
					className={cn('size-2 rounded-full', isUnhealthy ? 'bg-warning' : 'bg-success')}
					aria-hidden="true"
				/>
				<span className="text-sm font-medium text-foreground">
					{isUnhealthy ? 'Unhealthy' : 'Connected'}
				</span>
				{info.subscription_type && (
					<span
						className={cn(
							'rounded-full px-2 py-0.5 text-xs',
							isUnhealthy ? 'bg-warning/15 text-warning' : 'bg-muted text-muted-foreground',
						)}
					>
						{info.subscription_type}
					</span>
				)}
				<span className="text-xs text-muted-foreground">
					expires in {formatExpiry(info.expires_at)}
				</span>
				{info.fingerprint && (
					<span className="text-xs font-mono text-muted-foreground">id {info.fingerprint}</span>
				)}
			</div>
			{isUnhealthy && unhealthyReasonLine && (
				<p className="text-xs text-warning">{unhealthyReasonLine}</p>
			)}
			<div className="flex flex-wrap gap-2 pt-1">
				{slot === 'backup' && hasOtherSlot && (
					<Button
						variant="outline"
						size="sm"
						onClick={() => swapMutation.mutate()}
						disabled={swapMutation.isPending}
					>
						{swapMutation.isPending ? 'Swapping...' : 'Swap into primary'}
					</Button>
				)}
				<Button
					variant="ghost"
					size="sm"
					onClick={() => disconnectMutation.mutate()}
					disabled={disconnectMutation.isPending}
				>
					<Unplug size={14} className="mr-1" />
					Disconnect
				</Button>
			</div>
		</div>
	)
}

function FailoverBanner({
	reasonCopy,
	reasonCode,
}: {
	reasonCopy: (typeof FAILOVER_REASON_COPY)[string]
	reasonCode: string
}) {
	const [showVerbatim, setShowVerbatim] = useState(false)
	return (
		<div
			className="rounded-md border border-warning/30 bg-warning/5 px-3 py-3 mb-3 space-y-2"
			data-testid="failover-banner"
		>
			<p className="text-sm font-bold text-warning">Running on backup</p>
			<p className="text-xs text-foreground/80">{reasonCopy.bannerBody}</p>
			<button
				type="button"
				className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
				onClick={() => setShowVerbatim((v) => !v)}
				aria-expanded={showVerbatim}
			>
				{showVerbatim ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
				Failure detail
			</button>
			{showVerbatim && (
				<pre className="mt-1 text-xs font-mono text-muted-foreground bg-muted/30 rounded p-2 whitespace-pre-wrap overflow-auto max-h-40">
					classified reason: {reasonCode}
				</pre>
			)}
		</div>
	)
}

interface PasteFlowProps {
	workspaceId: string
	initialSlot: ClaudeOAuthSlot
	onClose: () => void
	onSuccess: () => void
}

function PasteFlow({ workspaceId, initialSlot, onClose, onSuccess }: PasteFlowProps) {
	const [pasteValue, setPasteValue] = useState('')
	const [slot, setSlot] = useState<ClaudeOAuthSlot>(initialSlot)
	const [parseError, setParseError] = useState('')

	const importMutation = useMutation({
		mutationFn: (tokens: ClaudeOAuthImportInput) => api.claudeOauth.import(workspaceId, tokens),
		onSuccess: () => {
			setPasteValue('')
			onSuccess()
			onClose()
		},
	})

	const handleImport = () => {
		setParseError('')
		const parsed = parseClaudeCredentials(pasteValue)
		if (!parsed) {
			setParseError('Could not find Claude OAuth tokens in the pasted JSON.')
			return
		}
		importMutation.mutate({ ...parsed, slot })
	}

	return (
		<div
			className="mt-3 rounded-lg border border-border bg-muted/30 p-3 space-y-3"
			data-testid="paste-flow"
		>
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
			<div className="space-y-1.5">
				<Label className="text-xs text-muted-foreground">Designate as</Label>
				<RadioGroup
					value={slot}
					onValueChange={(value) => setSlot(value as ClaudeOAuthSlot)}
					className="flex gap-4"
					aria-label="Slot designation"
				>
					<label
						htmlFor="paste-slot-primary"
						className="flex items-center gap-2 text-sm text-foreground cursor-pointer"
					>
						<RadioGroupItem value="primary" id="paste-slot-primary" />
						Primary
					</label>
					<label
						htmlFor="paste-slot-backup"
						className="flex items-center gap-2 text-sm text-foreground cursor-pointer"
					>
						<RadioGroupItem value="backup" id="paste-slot-backup" />
						Backup
					</label>
				</RadioGroup>
			</div>
			{(parseError || importMutation.isError) && (
				<p className="text-xs text-error">
					{parseError || importMutation.error?.message || 'Import failed'}
				</p>
			)}
			<div className="flex gap-2">
				<Button
					onClick={handleImport}
					disabled={!pasteValue.trim() || importMutation.isPending}
					size="sm"
				>
					{importMutation.isPending ? 'Importing...' : 'Import'}
				</Button>
				<Button
					variant="ghost"
					size="sm"
					onClick={() => {
						setPasteValue('')
						setParseError('')
						onClose()
					}}
				>
					Cancel
				</Button>
			</div>
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
			<Label className="mb-1 text-bold">LLM API Keys</Label>
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

interface CustomLlmConfig {
	enabled?: boolean
	base_url?: string | null
	api_key?: string | null
	model?: string | null
	small_fast_model?: string | null
}

function CustomLlmEditor({
	workspace,
	workspaceId,
}: {
	workspace: import('@/lib/api').WorkspaceWithRole
	workspaceId: string
}) {
	const updateWorkspace = useUpdateWorkspace(workspaceId)
	const settings = workspace.settings as Record<string, unknown>
	const saved = (settings?.custom_llm as CustomLlmConfig | undefined) ?? {}

	const [enabled, setEnabled] = useState(Boolean(saved.enabled))
	const [baseUrl, setBaseUrl] = useState(saved.base_url ?? '')
	const [apiKey, setApiKey] = useState(saved.api_key ?? '')
	const [model, setModel] = useState(saved.model ?? '')
	const [smallModel, setSmallModel] = useState(saved.small_fast_model ?? '')
	const [keyVisible, setKeyVisible] = useState(false)

	const handleSave = () => {
		const next: CustomLlmConfig = {
			enabled,
			base_url: baseUrl.trim() || null,
			api_key: apiKey.trim() || null,
			model: model.trim() || null,
			small_fast_model: smallModel.trim() || null,
		}
		updateWorkspace.mutate({
			settings: { ...settings, custom_llm: next },
		})
	}

	const isDirty =
		enabled !== Boolean(saved.enabled) ||
		baseUrl !== (saved.base_url ?? '') ||
		apiKey !== (saved.api_key ?? '') ||
		model !== (saved.model ?? '') ||
		smallModel !== (saved.small_fast_model ?? '')

	const canEnable = baseUrl.trim() && apiKey.trim() && model.trim()

	return (
		<div>
			<Label className="mb-1 text-bold">Custom Model Endpoint (beta)</Label>
			<p className="text-xs text-muted-foreground mb-3">
				Point Claude Code at any Anthropic-compatible endpoint — OpenRouter, a self-hosted
				vLLM/Ollama instance, or LM Studio. Takes precedence over the Claude subscription and
				Anthropic API key above. For OpenRouter, use{' '}
				<code className="font-mono text-xs">https://openrouter.ai/api</code> (no <code>/v1</code>).
			</p>

			<div className="space-y-3">
				<div className="flex items-center gap-2">
					<Switch
						checked={enabled}
						onCheckedChange={setEnabled}
						disabled={!canEnable && !enabled}
					/>
					<span className="text-sm text-foreground">{enabled ? 'Enabled' : 'Disabled'}</span>
				</div>

				<div>
					<Label className="mb-1 text-xs text-muted-foreground">Base URL</Label>
					<Input
						value={baseUrl}
						onChange={(e) => setBaseUrl(e.target.value)}
						placeholder="https://openrouter.ai/api"
					/>
				</div>

				<div>
					<Label className="mb-1 text-xs text-muted-foreground">API Key</Label>
					<div className="relative">
						<Input
							type={keyVisible ? 'text' : 'password'}
							value={apiKey}
							onChange={(e) => setApiKey(e.target.value)}
							placeholder="sk-or-..."
							className="pr-9"
						/>
						<button
							type="button"
							className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
							onClick={() => setKeyVisible((v) => !v)}
						>
							{keyVisible ? <EyeOff size={14} /> : <Eye size={14} />}
						</button>
					</div>
				</div>

				<div>
					<Label className="mb-1 text-xs text-muted-foreground">Model</Label>
					<Input
						value={model}
						onChange={(e) => setModel(e.target.value)}
						placeholder="deepseek/deepseek-v4-flash"
					/>
				</div>

				<div>
					<Label className="mb-1 text-xs text-muted-foreground">Small/fast model (optional)</Label>
					<Input
						value={smallModel}
						onChange={(e) => setSmallModel(e.target.value)}
						placeholder="Defaults to the model above"
					/>
				</div>

				<Button onClick={handleSave} disabled={!isDirty || updateWorkspace.isPending}>
					Save
				</Button>
			</div>
		</div>
	)
}
