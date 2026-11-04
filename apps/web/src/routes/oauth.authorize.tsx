import { Button } from '@/components/ui/button'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Spinner } from '@/components/ui/spinner'
import { useOauthPreview } from '@/hooks/use-oauth'
import { ApiError, api } from '@/lib/api'
import { clearAuth, getStoredActor, isAuthenticated } from '@/lib/auth'
import { cn } from '@/lib/cn'
import { inviteRoleLabel } from '@/lib/invite-format'
import type { OauthAuthorizeParams, OauthPreviewResponse } from '@maskin/shared'
import { createFileRoute, redirect, useNavigate } from '@tanstack/react-router'
import { Check, CircleAlert, OctagonAlert, ShieldOff, X } from 'lucide-react'
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react'

// The consent page for "Connect" in Claude (docs/reference/mcp-oauth.md). Claude sends the person here with an
// authorize request; the page asks the server to check it (preview), shows who is asking and what they would get,
// and sends the browser wherever the server says (approve or deny). It builds no redirect and shows nothing from
// the request: the client name, the return host and the workspace list all come from the server's answer.

export const Route = createFileRoute('/oauth/authorize')({
	beforeLoad: ({ location }) => {
		// Not signed in: log in first, then come back to this exact address with every parameter intact.
		if (!isAuthenticated()) {
			throw redirect({ to: '/login', search: { redirect: location.href } })
		}
	},
	head: () => ({ meta: [{ title: 'Connect an app — Maskin' }] }),
	component: AuthorizePage,
})

const PARAM_KEYS = [
	'response_type',
	'client_id',
	'redirect_uri',
	'code_challenge',
	'code_challenge_method',
	'state',
	'resource',
	'scope',
] as const

/** The authorize request as it sits in the address. Read raw: the router's search parser would turn a state like "123" into a number. */
function readParams(): OauthAuthorizeParams {
	const query = new URLSearchParams(window.location.search)
	const params: OauthAuthorizeParams = {}
	for (const key of PARAM_KEYS) {
		const value = query.get(key)
		if (value !== null) params[key] = value
	}
	return params
}

/** A link the server built, and only if it is a plain web address: nothing else is ever navigated to. */
function isWebUrl(value: string): boolean {
	try {
		const { protocol } = new URL(value)
		return protocol === 'https:' || protocol === 'http:'
	} catch {
		return false
	}
}

function hostOf(url: string, fallback: string): string {
	try {
		return new URL(url).host
	} catch {
		return fallback
	}
}

type Tone = 'red' | 'amber' | 'muted' | 'green'

type ErrorScreen =
	| { kind: 'unknown_app' }
	| { kind: 'redirect_mismatch' }
	| { kind: 'incomplete'; code: string; backUrl?: string }
	| { kind: 'cannot_check' }
	| { kind: 'unavailable' }

/** Turns a failed preview into one of the five error screens. The server's answer decides; nothing from the request is used. */
function errorScreenFor(error: unknown): ErrorScreen {
	if (!(error instanceof ApiError)) return { kind: 'cannot_check' }
	if (error.status === 403 || error.status === 404) return { kind: 'unavailable' }
	if (error.status !== 400) return { kind: 'cannot_check' }
	switch (error.code) {
		case 'client_not_allowlisted':
			return { kind: 'unknown_app' }
		case 'bad_redirect_uri':
			return { kind: 'redirect_mismatch' }
		case 'pkce_missing':
		case 'invalid_request':
		case 'unsupported_response_type':
		case 'invalid_scope':
		case 'invalid_target':
			return {
				kind: 'incomplete',
				code: error.code,
				backUrl: error.redirectUrl && isWebUrl(error.redirectUrl) ? error.redirectUrl : undefined,
			}
		default:
			return { kind: 'cannot_check' }
	}
}

function Shell({ children }: { children: ReactNode }) {
	return (
		<div className="flex min-h-screen items-center justify-center px-4 py-8">
			<div className="w-full max-w-md space-y-6">{children}</div>
		</div>
	)
}

/** Moves focus to the heading whenever the screen changes, so a screen reader starts at the top of the new one. */
function useHeadingFocus(screen: string) {
	const ref = useRef<HTMLHeadingElement>(null)
	// biome-ignore lint/correctness/useExhaustiveDependencies: re-run when the screen changes
	useEffect(() => {
		ref.current?.focus()
	}, [screen])
	return ref
}

const tileTone: Record<Tone, string> = {
	red: 'bg-status-failed-bg text-status-failed-text',
	amber: 'bg-status-processing-bg text-status-processing-text',
	muted: 'bg-muted text-muted-foreground',
	green: 'bg-status-live-bg text-status-live-text',
}

function StatusScreen({
	screen,
	icon,
	tone,
	title,
	children,
	action,
	reference,
	live,
}: {
	screen: string
	icon: ReactNode
	tone: Tone
	title: string
	children: ReactNode
	action?: ReactNode
	reference?: string
	live?: boolean
}) {
	const headingRef = useHeadingFocus(screen)
	return (
		<Shell>
			<div className="space-y-3 text-center" role={live ? 'status' : undefined}>
				<div
					aria-hidden="true"
					className={cn('mx-auto grid size-11 place-items-center rounded-xl', tileTone[tone])}
				>
					{icon}
				</div>
				<h1
					ref={headingRef}
					tabIndex={-1}
					className="text-2xl font-semibold tracking-tight outline-none"
				>
					{title}
				</h1>
				<p className="text-sm text-muted-foreground">{children}</p>
			</div>
			{action && <div className="flex justify-center">{action}</div>}
			{reference && (
				<p className="text-center font-mono text-xs text-muted-foreground">
					Reference: {reference}
				</p>
			)}
		</Shell>
	)
}

function CheckingScreen() {
	return (
		<Shell>
			<output className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
				<Spinner />
				Checking this request...
			</output>
		</Shell>
	)
}

function ErrorView({ error, onRetry }: { error: ErrorScreen; onRetry: () => void }) {
	switch (error.kind) {
		case 'unknown_app':
			return (
				<StatusScreen
					screen="unknown_app"
					tone="red"
					icon={<OctagonAlert size={20} />}
					title="Maskin doesn't recognise this app"
					reference="client_not_allowlisted"
				>
					Only apps Maskin has approved can ask for access. Nothing was shared.
				</StatusScreen>
			)
		case 'redirect_mismatch':
			return (
				<StatusScreen
					screen="redirect_mismatch"
					tone="red"
					icon={<OctagonAlert size={20} />}
					title="This link doesn't match the app"
					reference="bad_redirect_uri"
				>
					The address this app asked to return to isn't one it registered with Maskin. For your
					safety nothing was shared and you weren't sent back.
				</StatusScreen>
			)
		case 'incomplete':
			return (
				<StatusScreen
					screen="incomplete"
					tone="amber"
					icon={<CircleAlert size={20} />}
					title="Claude's request is incomplete"
					reference={error.code}
					action={
						error.backUrl ? (
							<Button asChild variant="outline">
								<a href={error.backUrl}>Back to Claude</a>
							</Button>
						) : undefined
					}
				>
					Maskin can't accept what it sent. Nothing was shared. Go back to Claude and try connecting
					again.
				</StatusScreen>
			)
		case 'cannot_check':
			return (
				<StatusScreen
					screen="cannot_check"
					tone="amber"
					icon={<CircleAlert size={20} />}
					title="Maskin couldn't check this request"
					action={
						<Button type="button" variant="outline" onClick={onRetry}>
							Try again
						</Button>
					}
				>
					We couldn't check the request just now. Nothing was shared. Try again in a minute.
				</StatusScreen>
			)
		case 'unavailable':
			return (
				<StatusScreen
					screen="unavailable"
					tone="muted"
					icon={<ShieldOff size={20} />}
					title="Not available for your account yet"
				>
					Connecting apps to Maskin isn't switched on for you yet. Nothing was shared.
				</StatusScreen>
			)
	}
}

function AccessItem({ allowed, children }: { allowed: boolean; children: ReactNode }) {
	const Icon = allowed ? Check : X
	return (
		<li className="flex items-start gap-2.5 text-[13px] leading-[1.55] text-foreground">
			<Icon
				size={14}
				aria-hidden="true"
				className={cn('mt-[3px] shrink-0', allowed ? 'text-success' : 'text-muted-foreground')}
			/>
			<span className="min-w-0 [text-wrap:pretty]">{children}</span>
		</li>
	)
}

type Outcome = { kind: 'success' | 'denied'; url: string; workspaceName?: string }

function ConsentView({
	preview,
	params,
}: { preview: OauthPreviewResponse; params: OauthAuthorizeParams }) {
	const navigate = useNavigate()
	const { client, workspaces } = preview
	const actor = getStoredActor()
	const [picked, setPicked] = useState<string | null>(null)
	const [busy, setBusy] = useState<'allow' | 'deny' | null>(null)
	const [failed, setFailed] = useState(false)
	const [outcome, setOutcome] = useState<Outcome | null>(null)

	const only = workspaces.length === 1 ? workspaces[0] : null
	const selected = only ?? workspaces.find((ws) => ws.id === picked) ?? null
	const clientHost = hostOf(client.client_id, client.redirect_host)
	const screen = outcome ? outcome.kind : workspaces.length === 0 ? 'no_workspace' : 'consent'
	const headingRef = useHeadingFocus(screen)

	const finish = (kind: Outcome['kind'], url: string, workspaceName?: string) => {
		if (!isWebUrl(url)) {
			setFailed(true)
			setBusy(null)
			return
		}
		setOutcome({ kind, url, workspaceName })
		window.location.assign(url)
	}

	const allow = async () => {
		if (!selected) return
		setBusy('allow')
		setFailed(false)
		try {
			const result = await api.oauth.approve({ ...params, workspace_id: selected.id })
			finish('success', result.redirect_url, selected.name)
		} catch {
			setFailed(true)
			setBusy(null)
		}
	}

	const deny = async () => {
		setBusy('deny')
		setFailed(false)
		try {
			const result = await api.oauth.deny({ ...params, workspace_id: selected?.id })
			finish('denied', result.redirect_url)
		} catch {
			setFailed(true)
			setBusy(null)
		}
	}

	const notYou = () => {
		clearAuth()
		navigate({
			to: '/login',
			search: { redirect: `${window.location.pathname}${window.location.search}` },
		})
	}

	if (outcome) {
		const connected = outcome.kind === 'success'
		return (
			<StatusScreen
				screen={outcome.kind}
				live
				tone={connected ? 'green' : 'muted'}
				icon={connected ? <Check size={20} /> : <X size={20} />}
				title={connected ? 'Connected' : 'Request denied'}
				action={
					<a
						href={outcome.url}
						className="text-sm text-primary hover:text-primary-hover"
						rel="noopener noreferrer"
					>
						Nothing happening? Continue to {client.redirect_host}
					</a>
				}
			>
				{connected
					? `${client.client_name} can now use ${outcome.workspaceName}. Going back to ${client.client_name}. You can close this page.`
					: `Nothing was shared. Going back to ${client.client_name}. You can close this page.`}
			</StatusScreen>
		)
	}

	if (workspaces.length === 0) {
		return (
			<Shell>
				<div className="space-y-3 text-center">
					<h1
						ref={headingRef}
						tabIndex={-1}
						className="text-2xl font-semibold tracking-tight outline-none"
					>
						No workspace to connect
					</h1>
					<p className="text-sm text-muted-foreground">
						You're not a member of any workspace. Ask a teammate to invite you, then press Connect
						in {client.client_name} again.
					</p>
				</div>
				<Button
					type="button"
					variant="outline"
					className="w-full"
					disabled={busy !== null}
					onClick={deny}
				>
					Deny
				</Button>
				{failed && (
					<p role="alert" className="text-xs text-error">
						We couldn't connect {client.client_name}. Check your connection and try again.
					</p>
				)}
			</Shell>
		)
	}

	const workspaceLabel = selected ? (
		<strong className="font-semibold">{selected.name}</strong>
	) : (
		'the workspace you choose'
	)
	const viewerRole = selected?.role === 'viewer' ? selected.role : null

	return (
		<Shell>
			<div className="text-center">
				<h1
					ref={headingRef}
					tabIndex={-1}
					className="text-2xl font-semibold tracking-tight outline-none"
				>
					Connect {client.client_name} to Maskin
				</h1>
				<p className="mt-1 text-sm text-muted-foreground">
					Signed in as {actor?.email ?? actor?.name ?? 'you'}.{' '}
					<button
						type="button"
						onClick={notYou}
						className="text-primary hover:text-primary-hover focus-visible:underline"
					>
						Not you?
					</button>
				</p>
			</div>

			<div className="rounded-xl border border-border bg-card p-4">
				<div className="flex items-center gap-3">
					<div
						aria-hidden="true"
						className="grid size-10 shrink-0 place-items-center rounded-lg bg-brand-subtle text-base font-semibold text-brand-subtle-foreground"
					>
						{client.client_name.charAt(0).toUpperCase()}
					</div>
					<div className="min-w-0">
						<div className="flex flex-wrap items-center gap-x-2 gap-y-1">
							<span className="text-sm font-semibold text-foreground">{client.client_name}</span>
							<span className="rounded-md bg-status-live-bg px-1.5 py-0.5 text-[10.5px] font-semibold text-status-live-text">
								Approved by Maskin
							</span>
						</div>
						<div className="truncate font-mono text-xs text-muted-foreground">{clientHost}</div>
					</div>
				</div>
				<p className="mt-3 border-t border-border-subtle pt-3 text-xs text-muted-foreground">
					After you choose, you go back to {client.redirect_host}
				</p>
			</div>

			{only ? (
				<div className="space-y-2">
					<h2 className="text-sm font-semibold text-foreground">Workspace</h2>
					<div className="flex items-center justify-between gap-3 rounded-lg border border-border bg-card p-3.5">
						<span className="min-w-0 truncate text-sm font-medium text-foreground">
							{only.name}
						</span>
						<span className="shrink-0 text-xs text-muted-foreground">Your only workspace</span>
					</div>
				</div>
			) : (
				<div className="space-y-2">
					<h2 id="workspace-heading" className="text-sm font-semibold text-foreground">
						Choose a workspace
					</h2>
					<p className="text-xs text-muted-foreground">
						{client.client_name} connects to one workspace at a time.
					</p>
					<RadioGroup
						aria-labelledby="workspace-heading"
						value={picked ?? ''}
						onValueChange={setPicked}
						disabled={busy !== null}
					>
						{workspaces.map((ws) => (
							<label
								key={ws.id}
								htmlFor={`ws-${ws.id}`}
								className={cn(
									'flex cursor-pointer items-center gap-3 rounded-lg border bg-card p-3.5 transition-colors hover:bg-muted',
									selected?.id === ws.id ? 'border-primary' : 'border-border',
								)}
							>
								<RadioGroupItem id={`ws-${ws.id}`} value={ws.id} />
								<span className="min-w-0 truncate text-sm font-medium text-foreground">
									{ws.name}
								</span>
							</label>
						))}
					</RadioGroup>
				</div>
			)}

			<div className="space-y-3 rounded-xl border border-border bg-surface-sunken p-4">
				<h2 className="text-sm font-semibold text-foreground">What {client.client_name} can do</h2>
				<ul className="space-y-2">
					<AccessItem allowed>
						See everything you can see in {workspaceLabel}: objects, files, comments and agents.
					</AccessItem>
					{viewerRole ? (
						<AccessItem allowed={false}>
							Can't change anything: you're a {inviteRoleLabel(viewerRole).toLowerCase()} in{' '}
							{workspaceLabel}, so {client.client_name} can't either.
						</AccessItem>
					) : (
						<AccessItem allowed>
							Create and change things as you, including deleting them. Changes show under your
							name.
						</AccessItem>
					)}
					<AccessItem allowed={false}>
						Never gets your password or your other workspaces.
					</AccessItem>
				</ul>
				<div className="space-y-1.5 border-t border-border-subtle pt-3 text-xs text-muted-foreground">
					<p>
						It stays connected until you disconnect it in Settings &gt; MCP. It also disconnects
						itself after 30 days unused.
					</p>
					<p>
						Removing Maskin inside {client.client_name} may not end access. Disconnect it in
						Settings &gt; MCP too.
					</p>
				</div>
			</div>

			{failed && (
				<p role="alert" className="text-xs text-error">
					We couldn't connect {client.client_name}. Check your connection and try again.
				</p>
			)}
			<div className="flex flex-col gap-2 sm:flex-row">
				<Button
					type="button"
					className="w-full sm:flex-1"
					disabled={!selected || busy !== null}
					aria-describedby={selected ? undefined : 'allow-helper'}
					onClick={allow}
				>
					{busy === 'allow' ? (
						<output className="inline-flex items-center gap-2">
							<Spinner />
							Connecting...
						</output>
					) : (
						'Allow'
					)}
				</Button>
				<Button
					type="button"
					variant="outline"
					className="w-full sm:flex-1"
					disabled={busy !== null}
					onClick={deny}
				>
					Deny
				</Button>
			</div>
			{!selected && (
				<p id="allow-helper" className="text-center text-xs text-muted-foreground">
					Choose a workspace to continue.
				</p>
			)}
		</Shell>
	)
}

function AuthorizePage() {
	const params = useMemo(readParams, [])
	const preview = useOauthPreview(params)

	if (preview.isPending) return <CheckingScreen />
	if (preview.isError) {
		return <ErrorView error={errorScreenFor(preview.error)} onRetry={() => preview.refetch()} />
	}
	return <ConsentView preview={preview.data} params={params} />
}
