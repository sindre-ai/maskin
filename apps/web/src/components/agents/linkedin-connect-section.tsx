import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { useConnectLinkedin, useLinkedinAccount } from '@/hooks/use-linkedin-account'
import type { LinkedinAccountResponse, LinkedinAccountState } from '@/lib/api'
import { cn } from '@/lib/cn'
import { AlertTriangle, Info, Link2, RefreshCw, ShieldAlert } from 'lucide-react'

// Capability flag on `actor.tools.capabilities` that opts an agent into the
// LinkedIn account UI on its detail page. Structural signal so we don't
// hard-code an actor name — matches the bet AC ("agents that declare a
// linkedin capability").
const LINKEDIN_CAPABILITY = 'linkedin'

/**
 * True when the agent's `tools.capabilities` array contains 'linkedin'.
 * Accepts the raw JSONB shape (`Record<string, unknown> | null`) so callers
 * pass `agent.tools` through without narrowing at the call site.
 */
export function hasLinkedinCapability(tools: Record<string, unknown> | null | undefined): boolean {
	if (!tools) return false
	const caps = tools.capabilities
	return Array.isArray(caps) && caps.includes(LINKEDIN_CAPABILITY)
}

interface LinkedinChannelsSectionProps {
	agentId: string
	workspaceId: string
	tools: Record<string, unknown> | null | undefined
}

/**
 * Channels heading + LinkedIn row + account panel on the SDR agent detail
 * page. Renders the seven lifecycle states from the parent bet: not-connected,
 * handoff, syncing, warm-up, healthy, reconnect, restricted.
 *
 * Only mounts for agents that declare the 'linkedin' capability — non-SDR
 * agents render nothing so a workspace without LinkedIn set up doesn't see
 * connect prompts on every agent.
 *
 * Restricted intentionally does not surface a reconnect CTA — reconnecting is
 * the wrong recovery for that state (see the bet guardrail). Reconnect state
 * gets a warn CTA; restricted only points at a recovery guide.
 */
export function LinkedinChannelsSection({
	agentId,
	workspaceId,
	tools,
}: LinkedinChannelsSectionProps) {
	const enabled = hasLinkedinCapability(tools)
	const { data: account, isLoading } = useLinkedinAccount(workspaceId, { enabled })
	if (!enabled) return null

	if (isLoading) {
		return (
			<div className="mb-6">
				<h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground mb-2">
					Channels
				</h3>
				<div className="flex items-center gap-2 text-sm text-muted-foreground">
					<Spinner /> Loading LinkedIn account…
				</div>
			</div>
		)
	}

	const state = deriveDisplayState(account)

	return (
		<div className="mb-8">
			<h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground mb-2">
				Channels
			</h3>
			<LinkedinChannelRow account={account} state={state} agentId={agentId} />
			{state !== 'not-connected' && state !== 'handoff' && account && (
				<div className="mt-4">
					<LinkedinAccountPanel account={account} state={state} />
				</div>
			)}
		</div>
	)
}

// Kept for backwards-compat with any importer during the T4 → T5 transition.
export const LinkedinConnectSection = LinkedinChannelsSection

// ── Hero pill ──────────────────────────────────────────────────────────────

/**
 * Renders the "Needs LinkedIn" / state pill for the agent hero metadata row.
 * Placed inline with the type badge + active/idle indicator so it participates
 * in the same wrap and touch-target sizing. Renders nothing unless the agent
 * declares the 'linkedin' capability.
 */
export function LinkedinHeroPill({
	workspaceId,
	tools,
}: {
	workspaceId: string
	tools: Record<string, unknown> | null | undefined
}) {
	const enabled = hasLinkedinCapability(tools)
	const { data: account, isLoading } = useLinkedinAccount(workspaceId, { enabled })
	if (!enabled) return null
	if (isLoading) return null
	const state = deriveDisplayState(account)
	const { text, tone } = HERO_PILL[state](account)
	if (!text) return null
	return (
		<span
			className={cn(
				'inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium',
				TONE_CLASSES[tone],
			)}
			aria-label={`LinkedIn: ${text}`}
		>
			<span
				aria-hidden="true"
				className={cn(
					'h-1.5 w-1.5 rounded-full',
					tone === 'sync' && 'animate-pulse',
					TONE_DOT[tone],
				)}
			/>
			{text}
		</span>
	)
}

// ── Sending-block hook ─────────────────────────────────────────────────────

export interface LinkedinSendingBlock {
	blocked: boolean
	reason: string | null
}

/**
 * Returns whether the current LinkedIn state blocks agent sending. Consumers
 * (the agent hero Run button) use this to disable the send-triggering
 * controls. `blocked: true` covers Restricted (LinkedIn stopped the account)
 * and Reconnect (session expired, no auth to send with).
 *
 * Agents without the 'linkedin' capability never send via LinkedIn, so a
 * LinkedIn Restricted / Reconnect state must not block their Run button —
 * this hook short-circuits to unblocked in that case.
 */
export function useLinkedinSendingBlock({
	workspaceId,
	tools,
}: {
	workspaceId: string
	tools: Record<string, unknown> | null | undefined
}): LinkedinSendingBlock {
	const enabled = hasLinkedinCapability(tools)
	const { data: account } = useLinkedinAccount(workspaceId, { enabled })
	if (!enabled) return { blocked: false, reason: null }
	if (!account) return { blocked: false, reason: null }
	if (account.state === 'restricted') {
		return { blocked: true, reason: 'LinkedIn restricted this account. Sending is stopped.' }
	}
	if (account.state === 'reconnect') {
		return { blocked: true, reason: 'LinkedIn session expired. Reconnect to resume sending.' }
	}
	return { blocked: false, reason: null }
}

// ── Internal ───────────────────────────────────────────────────────────────

type DisplayState =
	| 'not-connected'
	| 'handoff'
	| 'syncing'
	| 'warm_up'
	| 'healthy'
	| 'reconnect'
	| 'restricted'

type Tone = 'muted' | 'sync' | 'warn' | 'ok' | 'err'

const TONE_CLASSES: Record<Tone, string> = {
	muted: 'bg-status-todo-bg text-status-todo-text',
	sync: 'bg-status-in_progress-bg text-status-in_progress-text',
	warn: 'bg-status-in_review-bg text-status-in_review-text',
	ok: 'bg-status-active-bg text-status-active-text',
	err: 'bg-status-blocked-bg text-status-blocked-text',
}

const TONE_DOT: Record<Tone, string> = {
	muted: 'bg-status-todo-text',
	sync: 'bg-status-in_progress-text',
	warn: 'bg-status-in_review-text',
	ok: 'bg-status-active-text',
	err: 'bg-status-blocked-text',
}

const HERO_PILL: Record<
	DisplayState,
	(account: LinkedinAccountResponse | null | undefined) => { text: string | null; tone: Tone }
> = {
	'not-connected': () => ({ text: 'Needs LinkedIn', tone: 'muted' }),
	handoff: () => ({ text: 'Signing in…', tone: 'sync' }),
	syncing: () => ({ text: 'Syncing…', tone: 'sync' }),
	warm_up: (account) => {
		const w = account?.pacing.warmup
		return { text: w ? `Warming up · day ${w.day} of ${w.total}` : 'Warming up', tone: 'warn' }
	},
	healthy: () => ({ text: 'Connected', tone: 'ok' }),
	reconnect: () => ({ text: 'Paused · reconnect', tone: 'warn' }),
	restricted: () => ({ text: 'Restricted · stopped', tone: 'err' }),
}

function deriveDisplayState(account: LinkedinAccountResponse | null | undefined): DisplayState {
	if (!account) return 'not-connected'
	return account.state as DisplayState
}

function LinkedinChannelRow({
	account,
	state,
	agentId,
}: {
	account: LinkedinAccountResponse | null | undefined
	state: DisplayState
	agentId: string
}) {
	const workspaceId = account?.workspaceId ?? ''
	const connect = useConnectLinkedin(workspaceId)
	const sub = ROW_SUBS[state](account)
	const dotTone = ROW_DOT_TONE[state]
	return (
		<div className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4 sm:flex-row sm:items-center sm:gap-3">
			<span
				aria-hidden="true"
				className={cn(
					'h-3 w-3 shrink-0 rounded-full',
					dotTone === 'sync' && 'animate-pulse',
					TONE_DOT[dotTone],
				)}
			/>
			<div className="min-w-0 flex-1">
				<div className="text-sm font-medium text-foreground">LinkedIn</div>
				<div className="mt-0.5 text-xs text-muted-foreground">{sub}</div>
			</div>
			<div className="flex shrink-0 flex-wrap gap-2 sm:flex-nowrap">
				{state === 'not-connected' && (
					<Button
						type="button"
						size="sm"
						className="min-h-[44px] flex-1 sm:flex-none"
						onClick={() => connect.mutate({ agentId })}
						disabled={connect.isPending}
					>
						<Link2 size={14} aria-hidden="true" />
						{connect.isPending ? 'Opening…' : 'Connect LinkedIn'}
					</Button>
				)}
				{state === 'handoff' && (
					<Button
						type="button"
						variant="outline"
						size="sm"
						className="min-h-[44px] flex-1 sm:flex-none"
						onClick={() => connect.mutate({ agentId })}
						disabled={connect.isPending}
					>
						<RefreshCw size={14} aria-hidden="true" />
						{connect.isPending ? 'Reopening…' : 'Reopen Unipile'}
					</Button>
				)}
				{state === 'syncing' && (
					<Button
						type="button"
						variant="outline"
						size="sm"
						className="min-h-[44px] flex-1 sm:flex-none"
						disabled
					>
						<Spinner /> Syncing
					</Button>
				)}
				{state === 'reconnect' && (
					<Button
						type="button"
						size="sm"
						className="min-h-[44px] flex-1 sm:flex-none"
						onClick={() => connect.mutate({ agentId })}
						disabled={connect.isPending}
					>
						<RefreshCw size={14} aria-hidden="true" />
						{connect.isPending ? 'Opening…' : 'Reconnect'}
					</Button>
				)}
				{state === 'restricted' && (
					<Button
						type="button"
						variant="outline"
						size="sm"
						className="min-h-[44px] flex-1 sm:flex-none"
						asChild
					>
						<a
							href="https://www.linkedin.com/help/linkedin/answer/56070"
							target="_blank"
							rel="noreferrer"
						>
							<ShieldAlert size={14} aria-hidden="true" /> Recovery guide
						</a>
					</Button>
				)}
			</div>
		</div>
	)
}

const ROW_SUBS: Record<
	DisplayState,
	(account: LinkedinAccountResponse | null | undefined) => string
> = {
	'not-connected': () =>
		'Connect your LinkedIn so this agent can draft and send outreach on your behalf.',
	handoff: () => 'New tab opened on Unipile — sign in there. This page updates automatically.',
	syncing: () => 'Fetching your recent conversations from LinkedIn…',
	warm_up: (account) => {
		const w = account?.pacing.warmup
		const name = account?.sendingAsName ?? 'Your account'
		return w
			? `${name} · warm-up day ${w.day} of ${w.total} — sending is capped low.`
			: `${name} · warming up — sending is capped low.`
	},
	healthy: (account) =>
		`${account?.sendingAsName ?? 'Your account'} · sending on your behalf, approval-gated.`,
	reconnect: (account) =>
		`${account?.sendingAsName ?? 'Your account'} · session expired — SDR agent paused until you reconnect.`,
	restricted: (account) =>
		`${account?.sendingAsName ?? 'Your account'} · restricted by LinkedIn — all sending halted.`,
}

const ROW_DOT_TONE: Record<DisplayState, Tone> = {
	'not-connected': 'muted',
	handoff: 'sync',
	syncing: 'sync',
	warm_up: 'warn',
	healthy: 'ok',
	reconnect: 'warn',
	restricted: 'err',
}

// ── Account panel ──────────────────────────────────────────────────────────

function LinkedinAccountPanel({
	account,
	state,
}: {
	account: LinkedinAccountResponse
	state: DisplayState
}) {
	const identity = account.sendingAsName ?? 'LinkedIn account'
	const initials = deriveInitials(identity)
	const connectedAt = account.connectedAt ? formatConnectedAt(account.connectedAt) : null
	const callout = ACCOUNT_CALLOUT[state](account)
	return (
		<div className="rounded-lg border border-border bg-card p-4 sm:p-5">
			<div className="flex items-center gap-3">
				<span
					aria-hidden="true"
					className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-[#0a66c2] text-sm font-semibold text-white"
				>
					{initials}
				</span>
				<div className="min-w-0 flex-1">
					<div className="truncate text-sm font-semibold text-foreground">{identity}</div>
					<div className="mt-0.5 truncate text-xs text-muted-foreground">
						{connectedAt ? `Connected ${connectedAt} · via Unipile` : 'via Unipile'}
					</div>
				</div>
			</div>

			{callout && (
				<div
					className={cn(
						'mt-4 flex gap-3 rounded-md border p-3 text-xs',
						callout.tone === 'info' && 'border-status-in_progress-bg bg-status-in_progress-bg/40',
						callout.tone === 'warn' && 'border-status-in_review-bg bg-status-in_review-bg/40',
						callout.tone === 'err' && 'border-status-blocked-bg bg-status-blocked-bg/40',
					)}
					role={callout.tone === 'err' || callout.tone === 'warn' ? 'alert' : undefined}
				>
					<span aria-hidden="true" className="mt-0.5 shrink-0">
						{callout.tone === 'info' && <Info size={14} className="text-status-in_progress-text" />}
						{callout.tone === 'warn' && (
							<AlertTriangle size={14} className="text-status-in_review-text" />
						)}
						{callout.tone === 'err' && (
							<ShieldAlert size={14} className="text-status-blocked-text" />
						)}
					</span>
					<div className="min-w-0 flex-1">
						<div
							className={cn(
								'text-xs font-semibold',
								callout.tone === 'info' && 'text-status-in_progress-text',
								callout.tone === 'warn' && 'text-status-in_review-text',
								callout.tone === 'err' && 'text-status-blocked-text',
							)}
						>
							{callout.title}
						</div>
						<div className="mt-1 text-xs text-muted-foreground">{callout.text}</div>
					</div>
				</div>
			)}

			<div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
				<Metric
					label="Sending as"
					value="SDR agent"
					hint="Approval-gated · you review every send"
				/>
				<Metric
					label="Today"
					value={formatCount(account.pacing.dailySent, account.pacing.dailyCap)}
					hint="Sends · resets 00:00 CET"
				/>
				<Metric
					label="This week"
					value={formatCount(account.pacing.weeklySent, account.pacing.weeklyCap)}
					hint={`Acceptance ${formatAcceptance(account.acceptanceRate)}`}
				/>
			</div>
		</div>
	)
}

function Metric({ label, value, hint }: { label: string; value: string; hint: string }) {
	return (
		<div className="rounded-md bg-muted/60 px-3 py-2">
			<div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
				{label}
			</div>
			<div className="mt-1 text-lg font-semibold text-foreground">{value}</div>
			<div className="mt-0.5 text-[11px] text-muted-foreground">{hint}</div>
		</div>
	)
}

interface AccountCallout {
	tone: 'info' | 'warn' | 'err'
	title: string
	text: string
}

const ACCOUNT_CALLOUT: Record<
	DisplayState,
	(account: LinkedinAccountResponse) => AccountCallout | null
> = {
	'not-connected': () => null,
	handoff: () => null,
	syncing: () => ({
		tone: 'info',
		title: 'First-sync in progress (about 30–60 seconds)',
		text: "The SDR agent won't draft anything until first-sync completes. You can leave this page — we'll update the state here when it's done.",
	}),
	warm_up: (account) => {
		const w = account.pacing.warmup
		return {
			tone: 'warn',
			title: w ? `Warm-up · day ${w.day} of ${w.total}` : 'Warm-up',
			text: 'Your account is new to automation — pacing is capped low until day 14. Details in the linkedin-outreach-pacing skill.',
		}
	},
	healthy: () => null,
	reconnect: () => ({
		tone: 'warn',
		title: 'LinkedIn signed you out. Reconnect to keep the SDR agent running.',
		text: 'Your session expired. The SDR agent is paused — no drafts, no sends — until you reopen hosted-auth and resync.',
	}),
	restricted: () => ({
		tone: 'err',
		title: 'LinkedIn restricted this account. All Maskin sending is stopped.',
		text: 'This is a guardrail failure for the bet. Do not reconnect until LinkedIn lifts the restriction — read the recovery guide first.',
	}),
}

function deriveInitials(name: string): string {
	const parts = name.trim().split(/\s+/).slice(0, 2)
	if (parts.length === 0) return 'IN'
	return parts
		.map((p) => p[0]?.toUpperCase() ?? '')
		.join('')
		.slice(0, 2)
}

function formatConnectedAt(iso: string): string {
	try {
		const d = new Date(iso)
		return d.toLocaleDateString(undefined, {
			day: 'numeric',
			month: 'short',
		})
	} catch {
		return iso
	}
}

function formatCount(sent: number, cap: number): string {
	if (cap === 0) return '—'
	return `${sent} / ${cap}`
}

function formatAcceptance(rate: number | null): string {
	if (rate === null || Number.isNaN(rate)) return '—'
	return `${Math.round(rate * 100)}%`
}

// re-export the state type so callers can narrow without importing from api
export type { LinkedinAccountState }
