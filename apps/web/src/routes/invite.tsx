import { FormError } from '@/components/shared/form-error'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Spinner } from '@/components/ui/spinner'
import { ApiError, type InvitePreview, api } from '@/lib/api'
import { clearAuth, getApiKey, getStoredActor, setApiKey, setStoredActor } from '@/lib/auth'
import { useQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'

export const Route = createFileRoute('/invite')({
	validateSearch: (search: Record<string, unknown>) => ({
		token: typeof search.token === 'string' ? search.token : '',
	}),
	head: () => ({ meta: [{ title: 'Accept your invite — Maskin' }] }),
	component: InvitePage,
})

// The invite email links to /invite?token=…; the token is the only credential
// on the page, so it is never rendered, logged or sent anywhere but the two
// /api/invites calls below.

type Outcome = 'idle' | 'joined' | 'full'

function InviteShell({ children }: { children: React.ReactNode }) {
	return (
		<div className="flex min-h-screen items-center justify-center px-4">
			<div className="w-full max-w-sm space-y-6">{children}</div>
		</div>
	)
}

function InviteHeading({ title, children }: { title: string; children?: React.ReactNode }) {
	return (
		<div className="text-center">
			<h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
			{children && <p className="mt-1 text-sm text-muted-foreground">{children}</p>}
		</div>
	)
}

// Hard navigation, as signup does: the stored key just changed, so drop every
// cached query (workspace list, flags) rather than reconcile them.
function enterWorkspace(workspaceId: string) {
	window.location.assign(`/${workspaceId}`)
}

function InvitePage() {
	const { token } = Route.useSearch()
	const preview = useQuery({
		queryKey: ['invites', 'preview', token],
		queryFn: () => api.invites.preview(token),
		enabled: token.length > 0,
		retry: false,
	})
	// Bumped after sign-out so the signed-in checks below re-read storage.
	const [, setAuthVersion] = useState(0)
	const [outcome, setOutcome] = useState<Outcome>('idle')

	if (token.length > 0 && preview.isLoading) {
		return (
			<InviteShell>
				<output className="flex flex-col items-center gap-3 py-8">
					<Spinner />
					<p className="text-sm text-muted-foreground">Loading invite…</p>
				</output>
			</InviteShell>
		)
	}

	if (!preview.data) {
		const rateLimited = preview.error instanceof ApiError && preview.error.status === 429
		return (
			<InviteShell>
				<InviteHeading title={rateLimited ? 'Too many attempts' : 'This invite has expired'}>
					{rateLimited
						? 'Wait a minute, then open the link from your email again.'
						: 'The link has expired or been revoked. Ask the person who invited you to send a new one.'}
				</InviteHeading>
			</InviteShell>
		)
	}

	const invite = preview.data

	if (outcome === 'joined') {
		return (
			<InviteShell>
				<output className="flex flex-col items-center gap-3">
					<InviteHeading title="You're in.">Taking you to {invite.workspaceName}…</InviteHeading>
					<Spinner />
				</output>
			</InviteShell>
		)
	}

	if (outcome === 'full') {
		return (
			<InviteShell>
				<InviteHeading title={`${invite.workspaceName} is at capacity`}>
					All seats on this plan are filled. Ask {invite.inviterName} to upgrade the plan, then open
					the invite link again.
				</InviteHeading>
			</InviteShell>
		)
	}

	const apiKey = getApiKey()
	const actor = getStoredActor()
	const onJoined = (workspaceId: string) => {
		setOutcome('joined')
		enterWorkspace(workspaceId)
	}

	if (apiKey && actor) {
		const matches = (actor.email ?? '').toLowerCase() === invite.inviteEmail.toLowerCase()
		return (
			<AuthenticatedAccept
				token={token}
				invite={invite}
				actorEmail={actor.email ?? actor.name}
				matches={matches}
				onJoined={onJoined}
				onFull={() => setOutcome('full')}
				onSignedOut={() => setAuthVersion((v) => v + 1)}
			/>
		)
	}

	return (
		<SignedOutAccept
			token={token}
			invite={invite}
			onJoined={onJoined}
			onFull={() => setOutcome('full')}
		/>
	)
}

// Sub-branches 3 (signed in, email matches) and 4 (signed in, email differs).
function AuthenticatedAccept({
	token,
	invite,
	actorEmail,
	matches,
	onJoined,
	onFull,
	onSignedOut,
}: {
	token: string
	invite: InvitePreview
	actorEmail: string
	matches: boolean
	onJoined: (workspaceId: string) => void
	onFull: () => void
	onSignedOut: () => void
}) {
	const [error, setError] = useState('')
	const [loading, setLoading] = useState(false)

	const handleAccept = async () => {
		setLoading(true)
		setError('')
		try {
			const result = await api.invites.accept(token)
			onJoined(result.workspaceId)
		} catch (err) {
			if (err instanceof ApiError && err.status === 403 && err.code === 'SEAT_CAP_EXCEEDED') {
				onFull()
			} else if (err instanceof ApiError && err.status === 401) {
				// The stored key is stale. Drop it so the page falls back to the
				// signed-out branches instead of looping on the same 401.
				clearAuth()
				onSignedOut()
			} else {
				setError(err instanceof Error ? err.message : 'Could not accept the invite')
			}
		} finally {
			setLoading(false)
		}
	}

	const handleSignOut = () => {
		clearAuth()
		onSignedOut()
	}

	return (
		<InviteShell>
			{matches ? (
				<InviteHeading title={`Join ${invite.workspaceName}?`}>
					{invite.inviterName} invited you. You're signed in as{' '}
					<span className="font-medium text-foreground">{actorEmail}</span>.
				</InviteHeading>
			) : (
				<>
					<InviteHeading title="Different email on this invite">
						{invite.inviterName} invited you to {invite.workspaceName}.
					</InviteHeading>
					<dl className="space-y-3 rounded-lg border border-border p-4 text-sm">
						<div className="flex flex-col gap-0.5 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
							<dt className="text-muted-foreground">Invite is for</dt>
							<dd className="min-w-0 break-all font-medium">{invite.inviteEmail}</dd>
						</div>
						<div className="flex flex-col gap-0.5 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
							<dt className="text-muted-foreground">You're signed in as</dt>
							<dd className="min-w-0 break-all font-medium">{actorEmail}</dd>
						</div>
					</dl>
				</>
			)}
			{error && <FormError error={error} className="text-center" />}
			<div className="space-y-2">
				<Button type="button" className="w-full" onClick={handleAccept} disabled={loading}>
					<span className="truncate">
						{loading ? 'Joining…' : matches ? 'Accept invite' : `Accept as ${actorEmail}`}
					</span>
				</Button>
				{matches ? (
					<Button
						type="button"
						variant="ghost"
						className="w-full"
						onClick={() => window.location.assign('/')}
						disabled={loading}
					>
						Decline
					</Button>
				) : (
					<>
						<Button
							type="button"
							variant="outline"
							className="w-full"
							onClick={handleSignOut}
							disabled={loading}
						>
							<span className="truncate">Sign out to use {invite.inviteEmail}</span>
						</Button>
						<p className="text-center text-xs text-muted-foreground">
							Signing out will end your current session.
						</p>
					</>
				)}
			</div>
		</InviteShell>
	)
}

// Sub-branch 1 (no account: create one) and 2 (has an account: sign in). The
// preview can't say which applies without leaking whether an account exists,
// so sign-up is the default and a 409 from accept flips to sign-in.
function SignedOutAccept({
	token,
	invite,
	onJoined,
	onFull,
}: {
	token: string
	invite: InvitePreview
	onJoined: (workspaceId: string) => void
	onFull: () => void
}) {
	const [mode, setMode] = useState<'signup' | 'signin'>('signup')
	const [notice, setNotice] = useState('')
	const [name, setName] = useState('')
	const [password, setPassword] = useState('')
	const [error, setError] = useState('')
	const [loading, setLoading] = useState(false)

	const switchMode = (next: 'signup' | 'signin', message = '') => {
		setMode(next)
		setNotice(message)
		setError('')
		setPassword('')
	}

	const handleError = (err: unknown) => {
		if (err instanceof ApiError && err.status === 403 && err.code === 'SEAT_CAP_EXCEEDED') {
			onFull()
		} else if (err instanceof ApiError && err.status === 409 && mode === 'signup') {
			switchMode('signin', 'You already have a Maskin account. Sign in to accept the invite.')
		} else {
			setError(err instanceof Error ? err.message : 'Something went wrong')
		}
	}

	const handleSubmit = async (e: React.FormEvent) => {
		e.preventDefault()
		if (password.length < 8) {
			setError('Password must be at least 8 characters')
			return
		}
		setLoading(true)
		setError('')
		try {
			if (mode === 'signup') {
				const trimmedName = name.trim()
				const result = await api.invites.accept(token, {
					email: invite.inviteEmail,
					password,
					...(trimmedName ? { name: trimmedName } : {}),
				})
				if ('actor' in result) {
					setApiKey(result.actor.api_key)
					setStoredActor({
						id: result.actor.id,
						name: result.actor.name,
						type: result.actor.type,
						email: result.actor.email,
					})
				}
				onJoined(result.workspaceId)
			} else {
				const actor = await api.auth.login({ email: invite.inviteEmail, password })
				setApiKey(actor.api_key)
				setStoredActor({ id: actor.id, name: actor.name, type: actor.type, email: actor.email })
				try {
					const result = await api.invites.accept(token)
					onJoined(result.workspaceId)
				} catch (err) {
					// Signed in, but the accept itself failed: the Authorization
					// header now carries the key, so a retry needs no re-login.
					handleError(err)
				}
			}
		} catch (err) {
			handleError(err)
		} finally {
			setLoading(false)
		}
	}

	const signup = mode === 'signup'

	return (
		<InviteShell>
			<InviteHeading
				title={signup ? `Join ${invite.workspaceName} on Maskin` : 'Sign in to accept'}
			>
				{signup
					? `${invite.inviterName} invited you.`
					: `${invite.inviterName} invited you to ${invite.workspaceName}.`}
			</InviteHeading>
			<form onSubmit={handleSubmit} className="space-y-4">
				{notice && <p className="text-sm text-muted-foreground">{notice}</p>}
				<div>
					<Label htmlFor="invite-accept-email" className="mb-1 text-muted-foreground">
						Email
					</Label>
					<Input id="invite-accept-email" type="email" value={invite.inviteEmail} disabled />
					{signup && (
						<p className="mt-1 text-xs text-muted-foreground">
							The invite is tied to this address.
						</p>
					)}
				</div>
				{signup && (
					<div>
						<Label htmlFor="invite-accept-name" className="mb-1 text-muted-foreground">
							Your name
						</Label>
						<Input
							id="invite-accept-name"
							type="text"
							value={name}
							onChange={(e) => setName(e.target.value)}
							placeholder="Ada Lovelace"
							autoFocus
						/>
					</div>
				)}
				<div>
					<Label htmlFor="invite-accept-password" className="mb-1 text-muted-foreground">
						Password
					</Label>
					<Input
						id="invite-accept-password"
						type="password"
						value={password}
						onChange={(e) => {
							setPassword(e.target.value)
							setError('')
						}}
						placeholder={signup ? 'At least 8 characters' : 'Your password'}
						autoFocus={!signup}
					/>
				</div>
				{error && <FormError error={error} />}
				<Button type="submit" disabled={loading} className="w-full">
					{loading
						? signup
							? 'Creating...'
							: 'Signing in...'
						: signup
							? 'Create account & join'
							: 'Sign in & join workspace'}
				</Button>
			</form>
			<p className="text-center text-xs text-muted-foreground">
				{signup ? 'Already have a Maskin account? ' : "Don't have an account yet? "}
				<button
					type="button"
					className="text-primary hover:text-primary-hover"
					onClick={() => switchMode(signup ? 'signin' : 'signup')}
				>
					{signup ? 'Sign in instead' : 'Create one'}
				</button>
			</p>
		</InviteShell>
	)
}
