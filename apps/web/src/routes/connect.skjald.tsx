import { FormError } from '@/components/shared/form-error'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { useWorkspaces } from '@/hooks/use-workspaces'
import { api } from '@/lib/api'
import { isAuthenticated } from '@/lib/auth'
import { cn } from '@/lib/cn'
import { SKJALD_CONNECT_REDIRECT_URI } from '@maskin/shared'
import { createFileRoute, redirect } from '@tanstack/react-router'
import { useState } from 'react'

// "Connect with Maskin" from the Skjald app. The app opens this page in its web sheet; the person picks a workspace
// and presses Connect, and the browser is sent back to the app (skjald://) with a one-time code. The signing secret
// is made on the server and handed to the app by the code, so it is never on this page.

export const Route = createFileRoute('/connect/skjald')({
	validateSearch: (search: Record<string, unknown>) => ({
		state: typeof search.state === 'string' ? search.state : '',
		code_challenge: typeof search.code_challenge === 'string' ? search.code_challenge : '',
		code_challenge_method:
			typeof search.code_challenge_method === 'string' ? search.code_challenge_method : '',
		redirect_uri: typeof search.redirect_uri === 'string' ? search.redirect_uri : '',
	}),
	beforeLoad: ({ location }) => {
		// Not signed in: log in first, then come back to this exact page.
		if (!isAuthenticated()) {
			throw redirect({ to: '/login', search: { redirect: location.href } })
		}
	},
	head: () => ({ meta: [{ title: 'Connect Skjald — Maskin' }] }),
	component: ConnectSkjaldPage,
})

function Shell({ children }: { children: React.ReactNode }) {
	return (
		<div className="flex min-h-screen items-center justify-center px-4">
			<div className="w-full max-w-sm space-y-6">{children}</div>
		</div>
	)
}

function ConnectSkjaldPage() {
	const search = Route.useSearch()
	const { data: workspaces, isLoading } = useWorkspaces()
	const [picked, setPicked] = useState<string | null>(null)
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState('')
	const [done, setDone] = useState(false)

	// Only the Skjald app's own redirect is accepted; anything else is not a link the app made.
	const valid =
		search.redirect_uri === SKJALD_CONNECT_REDIRECT_URI &&
		search.state.length >= 8 &&
		/^[A-Za-z0-9_-]{43}$/.test(search.code_challenge) &&
		search.code_challenge_method === 'S256'

	if (!valid) {
		return (
			<Shell>
				<div className="text-center">
					<h1 className="text-2xl font-semibold tracking-tight">This link is not valid</h1>
					<p className="mt-1 text-sm text-muted-foreground">
						Open Skjald and choose Connect with Maskin again.
					</p>
				</div>
			</Shell>
		)
	}

	if (done) {
		return (
			<Shell>
				<div className="text-center">
					<h1 className="text-2xl font-semibold tracking-tight">Connected</h1>
					<p className="mt-1 text-sm text-muted-foreground">
						Going back to Skjald. You can close this page.
					</p>
				</div>
			</Shell>
		)
	}

	const selected = picked ?? workspaces?.[0]?.id ?? null

	const connect = async () => {
		if (!selected) return
		setBusy(true)
		setError('')
		try {
			const result = await api.integrations.skjaldAuthorize(selected, {
				state: search.state,
				redirect_uri: search.redirect_uri,
				code_challenge: search.code_challenge,
				code_challenge_method: 'S256',
			})
			setDone(true)
			window.location.href = result.redirect_url
		} catch (err) {
			setError(err instanceof Error ? err.message : 'Could not connect')
			setBusy(false)
		}
	}

	const cancel = () => {
		window.location.href = `${SKJALD_CONNECT_REDIRECT_URI}?error=access_denied&state=${encodeURIComponent(search.state)}`
	}

	return (
		<Shell>
			<div className="text-center">
				<h1 className="text-2xl font-semibold tracking-tight">Connect Skjald</h1>
				<p className="mt-1 text-sm text-muted-foreground">
					Skjald will send the written-up outcome of your meetings to the workspace you choose. The
					audio never leaves your device.
				</p>
			</div>

			{isLoading ? (
				<div className="flex justify-center">
					<Spinner />
				</div>
			) : (
				<div className="space-y-2">
					{workspaces?.map((ws) => (
						<button
							key={ws.id}
							type="button"
							aria-pressed={selected === ws.id}
							onClick={() => setPicked(ws.id)}
							className={cn(
								'block w-full rounded-lg border bg-card p-4 text-left transition-all hover:bg-muted',
								selected === ws.id ? 'border-primary' : 'border-border',
							)}
						>
							<p className="text-sm font-medium text-foreground">{ws.name}</p>
						</button>
					))}
				</div>
			)}

			<FormError error={error} />
			<div className="space-y-2">
				<Button className="w-full" disabled={busy || !selected} onClick={connect}>
					{busy ? 'Connecting…' : 'Connect'}
				</Button>
				<Button variant="ghost" className="w-full" disabled={busy} onClick={cancel}>
					Cancel
				</Button>
			</div>
		</Shell>
	)
}
