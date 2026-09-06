import { EmptyState } from '@/components/shared/empty-state'
import { FormError } from '@/components/shared/form-error'
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
import { Link, createFileRoute } from '@tanstack/react-router'
import { ArrowUp, ChevronDown, ChevronRight, Eye, EyeOff, Pencil, Unplug } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'

export const Route = createFileRoute('/_authed/$workspaceId/settings/keys')({
	component: KeysPage,
	errorComponent: ({ error }) => <RouteError error={error} />,
})

function KeysPage() {
	const { workspace, workspaceId } = useWorkspace()
	const enterprise = Boolean(workspace.enterprise)
	return (
		<div className="space-y-6">
			{enterprise ? (
				<div className="max-w-lg space-y-6">
					<div className="border-t border-border pt-6">
						<ClaudeOAuthSection workspaceId={workspaceId} />
					</div>

					<div className="border-t border-border pt-6">
						<LLMKeysEditor workspace={workspace} workspaceId={workspaceId} />
					</div>

					<div className="border-t border-border pt-6">
						<CustomLlmEditor workspace={workspace} workspaceId={workspaceId} />
					</div>
				</div>
			) : (
				// Every section above is gated on `enterprise`, so a workspace without
				// that grant would otherwise render a blank page. `byollm_allowed` is an
				// ops grant, not a self-serve toggle, so this says who enables it
				// instead of offering a dead button.
				<EmptyState
					title="Bring-your-own-LLM isn't enabled for this workspace"
					description="Agents run on your Maskin plan. Connecting your own Claude subscription, API keys or a custom endpoint is enabled per workspace by Maskin."
					action={
						<Button variant="outline" size="sm" asChild>
							<Link to="/$workspaceId/settings/billing" params={{ workspaceId }}>
								View plan and usage
							</Link>
						</Button>
					}
				/>
			)}
		</div>
	)
}

const NICKNAME_PLACEHOLDER = 'Add a nickname'

// Map a classified failover reason (written by the classifier in T4/T6) to
// the customer-facing line shown next to the unhealthy subscription. Reasons
// outside this map render generically rather than leaking raw codes.
const FAILOVER_REASON_COPY: Record<string, { slotLine: string; bannerBody: string }> = {
	auth_failed: {
		slotLine: 'Authentication failed. Reconnect to use this subscription again.',
		bannerBody:
			'That subscription needs to be reconnected. Agents are running on the next one in the list until then.',
	},
	token_expired: {
		slotLine: 'Credentials expired. Reconnect to use this subscription again.',
		bannerBody:
			'That subscription needs to be reconnected. Agents are running on the next one in the list until then.',
	},
	quota_exhausted_5h: {
		slotLine: '5-hour usage limit reached.',
		bannerBody:
			'It hit its 5-hour usage limit. Agents are running on the next subscription until it resets.',
	},
	quota_exhausted_weekly: {
		slotLine: 'Weekly usage limit reached.',
		bannerBody:
			'It hit its weekly usage limit. Agents are running on the next subscription until it resets.',
	},
	quota_exhausted: {
		slotLine: 'Usage limit reached.',
		bannerBody:
			'It hit a usage limit. Agents are running on the next subscription until it recovers.',
	},
}

/**
 * Cards are labelled by POSITION in the failover chain, not by slot id: the
 * first one connected is the primary, the second is the backup, and anything
 * after that is a numbered fallback. Ids stay stable when a subscription in
 * the middle is disconnected, so position is the only thing that reliably
 * describes when a credential gets used.
 */
function slotLabel(position: number): string {
	if (position === 0) return 'Primary'
	if (position === 1) return 'Backup'
	return `Fallback ${position + 1}`
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
	const chain = status?.chain ?? []
	const connectedSlots = chain
		.map((id) => status?.slots[id])
		.filter((info): info is ClaudeOAuthSlotInfo => Boolean(info))
	const head = connectedSlots[0]
	const canAddMore = (status?.slots_remaining ?? MAX_SLOTS_FALLBACK) > 0

	// "Running on a fallback": sessions are served by something other than the
	// first subscription in the list, and we know why the first one stepped
	// aside.
	const failedOver = Boolean(
		status?.connected && head && status.active_slot !== head.slot && head.failure_reason,
	)
	const reasonCopy = head?.failure_reason ? FAILOVER_REASON_COPY[head.failure_reason] : undefined
	// -1 when `active_slot` isn't in the rendered chain. slotLabel(-1) reads
	// "Fallback 0"; stay vague rather than name a position we haven't found.
	const activePosition = connectedSlots.findIndex((info) => info.slot === status?.active_slot)

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
			<Label className="mb-1 text-bold">Claude Subscriptions</Label>
			<p className="text-xs text-muted-foreground mb-3">
				Connect your Claude Pro/Max/Teams subscriptions to use them for agent sessions instead of an
				API key. Sessions use the first one in this list; if it hits a usage limit or its
				credentials expire, they fall through to the next, and so on down the list.
			</p>

			{failedOver && reasonCopy && head && (
				<FailoverBanner
					reasonCopy={reasonCopy}
					reasonCode={head.failure_reason ?? ''}
					activeLabel={activePosition >= 0 ? slotLabel(activePosition) : 'another subscription'}
				/>
			)}

			<div className="grid grid-cols-1 md:grid-cols-2 gap-3" data-testid="claude-oauth-slots">
				{connectedSlots.map((info, position) => (
					<SlotCard
						key={info.slot}
						info={info}
						position={position}
						activeSlot={status?.active_slot}
						workspaceId={workspaceId}
						onSuccess={invalidate}
						onReplaceClick={() => setPasteSlot(info.slot)}
					/>
				))}
				{canAddMore && (
					<AddSlotCard
						position={connectedSlots.length}
						onConnectClick={() => setPasteSlot(connectedSlots.length === 0 ? 'primary' : NEW_SLOT)}
					/>
				)}
			</div>

			{pasteSlot && (
				<PasteFlow
					workspaceId={workspaceId}
					initialSlot={pasteSlot}
					connectedSlots={connectedSlots}
					canAddMore={canAddMore}
					onClose={closePaste}
					onSuccess={invalidate}
				/>
			)}
		</div>
	)
}

/** Sentinel understood by POST /claude-oauth/import — append to the chain. */
const NEW_SLOT = 'new'

/**
 * Only used before the first status response lands, to decide whether to offer
 * the "add" card. The server is the authority on the real cap.
 */
const MAX_SLOTS_FALLBACK = 10

function AddSlotCard({
	position,
	onConnectClick,
}: {
	position: number
	onConnectClick: () => void
}) {
	const isFirst = position === 0
	return (
		<div
			className="rounded-lg border border-dashed border-border bg-transparent p-3 space-y-2"
			data-slot="add"
			data-testid="slot-add"
		>
			<div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
				{slotLabel(position)}
			</div>
			<div className="text-sm font-medium text-muted-foreground">
				{isFirst ? 'No subscription connected' : 'Add another subscription'}
			</div>
			<p className="text-xs text-muted-foreground leading-snug">
				{isFirst
					? 'Connect your Claude subscription to start running agent sessions.'
					: 'When every subscription above has hit its usage limit or expired, agents stop until you reconnect one. Another keeps them running.'}
			</p>
			<Button variant="outline" size="sm" onClick={onConnectClick}>
				{isFirst ? 'Import credentials' : 'Import another subscription'}
			</Button>
		</div>
	)
}

interface SlotCardProps {
	info: ClaudeOAuthSlotInfo
	position: number
	activeSlot: ClaudeOAuthSlot | undefined
	workspaceId: string
	onSuccess: () => void
	onReplaceClick: () => void
}

function SlotCard({
	info,
	position,
	activeSlot,
	workspaceId,
	onSuccess,
	onReplaceClick,
}: SlotCardProps) {
	const slot = info.slot
	const disconnectMutation = useMutation({
		mutationFn: () => api.claudeOauth.disconnect(workspaceId, slot),
		onSuccess,
	})

	const promoteMutation = useMutation({
		mutationFn: () => api.claudeOauth.promote(workspaceId, slot),
		onSuccess,
	})

	const renameMutation = useMutation({
		mutationFn: (nickname: string) => api.claudeOauth.rename(workspaceId, slot, nickname),
		onSuccess,
		onError: () => {
			editingNickname.current = false
			setNicknameDraft(info.nickname ?? '')
		},
	})

	const [nicknameDraft, setNicknameDraft] = useState(info.nickname ?? '')
	// True from focus until the rename settles. Any status refetch that lands
	// in that window — a sibling mutation on this page invalidates the same
	// query — must not reset the field to the server's value and delete what
	// the user is halfway through typing.
	const editingNickname = useRef(false)
	useEffect(() => {
		if (editingNickname.current) return
		setNicknameDraft(info.nickname ?? '')
	}, [info.nickname])

	const nicknameInputRef = useRef<HTMLInputElement>(null)

	const handleNicknameBlur = () => {
		const trimmed = nicknameDraft.trim()
		if (trimmed === (info.nickname ?? '')) {
			editingNickname.current = false
			return
		}
		renameMutation.mutate(trimmed, {
			// Release the guard only once the server has the new value, so the
			// refetch this mutation triggers can't roll the field back either.
			onSettled: () => {
				editingNickname.current = false
			},
		})
	}

	const label = slotLabel(position)
	const accountLine = [info.account_email, info.account_organization].filter(Boolean).join(' · ')
	const isActive = activeSlot === slot
	const reasonCopy = info.failure_reason ? FAILOVER_REASON_COPY[info.failure_reason] : undefined
	// A recorded failure only means "unhealthy" while something else is
	// serving: once this subscription is the active one again, session start
	// has either cleared the record or is about to re-probe it.
	const isUnhealthy = Boolean(info.failure_reason) && !isActive
	const unhealthyLine = isUnhealthy
		? (reasonCopy?.slotLine ?? 'This subscription was rejected on its last attempt.')
		: null

	return (
		<div
			className="rounded-lg border border-border bg-card p-3 space-y-2"
			data-slot={slot}
			data-testid={`slot-${slot}`}
			data-position={position}
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
			<div>
				<div className="flex items-center gap-1 w-fit max-w-full">
					<input
						ref={nicknameInputRef}
						type="text"
						value={nicknameDraft}
						onChange={(e) => {
							setNicknameDraft(e.target.value)
							if (renameMutation.isError) renameMutation.reset()
						}}
						onBlur={handleNicknameBlur}
						onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
						placeholder={NICKNAME_PLACEHOLDER}
						onFocus={() => {
							editingNickname.current = true
						}}
						maxLength={60}
						size={Math.max(nicknameDraft.length, NICKNAME_PLACEHOLDER.length)}
						disabled={renameMutation.isPending}
						aria-label={`Nickname for ${label} slot`}
						data-testid={`slot-${slot}-nickname`}
						className="min-w-0 max-w-full bg-transparent border-none outline-none text-sm font-medium text-foreground placeholder:text-muted-foreground/70 focus:outline-none px-0 py-0 disabled:opacity-60"
					/>
					<button
						type="button"
						onClick={() => nicknameInputRef.current?.focus()}
						className="shrink-0 text-muted-foreground/60 hover:text-foreground transition-colors"
						aria-label={`Edit nickname for ${label} slot`}
						tabIndex={-1}
					>
						<Pencil size={12} />
					</button>
				</div>
				{renameMutation.isError && (
					<FormError error={renameMutation.error?.message || 'Could not save nickname'} />
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
			{accountLine && (
				// Anthropic's own name for this subscription. Shown alongside the
				// nickname rather than instead of it: the same Anthropic account
				// can be connected to several workspaces, each of which may want
				// to call it something different.
				<p
					className="text-xs text-muted-foreground truncate"
					title={accountLine}
					data-testid={`slot-${slot}-account`}
				>
					{accountLine}
				</p>
			)}
			{unhealthyLine && <p className="text-xs text-warning">{unhealthyLine}</p>}
			<div className="flex flex-wrap gap-2 pt-1">
				{position > 0 && (
					<Button
						variant="outline"
						size="sm"
						onClick={() => promoteMutation.mutate()}
						disabled={promoteMutation.isPending}
					>
						<ArrowUp size={14} className="mr-1" />
						{promoteMutation.isPending ? 'Moving...' : 'Use first'}
					</Button>
				)}
				<Button variant="ghost" size="sm" onClick={onReplaceClick}>
					Replace
				</Button>
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
	activeLabel,
}: {
	reasonCopy: (typeof FAILOVER_REASON_COPY)[string]
	reasonCode: string
	activeLabel: string
}) {
	const [showVerbatim, setShowVerbatim] = useState(false)
	return (
		<div
			className="rounded-md border border-warning/30 bg-warning/5 px-3 py-3 mb-3 space-y-2"
			data-testid="failover-banner"
		>
			<p className="text-sm font-bold text-warning">Running on {activeLabel.toLowerCase()}</p>
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
	connectedSlots: ClaudeOAuthSlotInfo[]
	canAddMore: boolean
	onClose: () => void
	onSuccess: () => void
}

function PasteFlow({
	workspaceId,
	initialSlot,
	connectedSlots,
	canAddMore,
	onClose,
	onSuccess,
}: PasteFlowProps) {
	const [pasteValue, setPasteValue] = useState('')
	const [slot, setSlot] = useState<string>(initialSlot)
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
				<Label className="text-xs text-muted-foreground">Save as</Label>
				<RadioGroup
					value={slot}
					onValueChange={setSlot}
					className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:gap-4"
					aria-label="Which subscription to save these credentials as"
				>
					{connectedSlots.map((info, position) => (
						<label
							key={info.slot}
							htmlFor={`paste-slot-${info.slot}`}
							className="flex items-center gap-2 text-sm text-foreground cursor-pointer"
						>
							<RadioGroupItem value={info.slot} id={`paste-slot-${info.slot}`} />
							Replace {info.nickname?.trim() || slotLabel(position)}
						</label>
					))}
					{canAddMore && connectedSlots.length > 0 && (
						<label
							htmlFor="paste-slot-new"
							className="flex items-center gap-2 text-sm text-foreground cursor-pointer"
						>
							<RadioGroupItem value={NEW_SLOT} id="paste-slot-new" />
							Add as {slotLabel(connectedSlots.length)}
						</label>
					)}
					{connectedSlots.length === 0 && (
						<label
							htmlFor="paste-slot-primary"
							className="flex items-center gap-2 text-sm text-foreground cursor-pointer"
						>
							<RadioGroupItem value="primary" id="paste-slot-primary" />
							Primary
						</label>
					)}
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
			settings: { llm_keys: updatedKeys },
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
			settings: { custom_llm: next },
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
