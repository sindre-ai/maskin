import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useVaerkstedAuth } from '@/hooks/use-vaerksted-auth'
import { trackEvent } from '@/lib/analytics'
import { api } from '@/lib/api'
import { Link, createFileRoute } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'

export const Route = createFileRoute('/signup')({
	component: SignupPage,
})

function SignupPage() {
	const { loading, sendMagicLink, completeFromRedirect } = useVaerkstedAuth()
	const [name, setName] = useState('')
	const [organization, setOrganization] = useState('')
	const [role, setRole] = useState('')
	const [email, setEmail] = useState('')
	const [sent, setSent] = useState(false)
	const [error, setError] = useState('')

	const startedRef = useRef(false)
	useEffect(() => {
		if (startedRef.current) return
		startedRef.current = true
		trackEvent('signup_form_started', {})
	}, [])

	useEffect(() => {
		const url = new URL(window.location.href)
		const pendingPrompt = url.searchParams.get('pending_prompt')
		const anonId = url.searchParams.get('anon_id')
		if (!pendingPrompt && !anonId) return

		try {
			if (pendingPrompt) {
				console.info('[maskin] imported pending prompt from URL', {
					promptChars: pendingPrompt.length,
				})
				localStorage.setItem('maskin_pending_prompt', pendingPrompt)
			}
			if (anonId) {
				localStorage.setItem('maskin_anon_id', anonId)
			}
		} catch (err) {
			console.error('[maskin] failed to import landing params from URL', err)
		}

		url.searchParams.delete('pending_prompt')
		url.searchParams.delete('anon_id')
		window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`)
	}, [])

	// Completes the magic-link round trip (vaerksted-auth-and-sync.md §6/§8).
	// Only meaningfully fires post-signup side effects (analytics, guest-draft
	// claim) for a genuinely NEW actor — is_new_actor is false for a returning
	// user who lands on /signup by mistake (they're just logged in, same as
	// /login would do).
	// biome-ignore lint/correctness/useExhaustiveDependencies: intentionally run once on mount only.
	useEffect(() => {
		completeFromRedirect()
			.then((result) => {
				if (!result?.is_new_actor) return
				const anonId = localStorage.getItem('maskin_anon_id')
				trackEvent('signup_form_submitted', { user_id: result.id, completed: true })
				if (anonId) {
					api.landingEvents
						.emit([{ name: 'signup_complete', anonId, props: { fromGuest: true } }])
						.catch(() => console.error('[maskin] failed to emit signup_complete'))
				}
			})
			.catch((err) => {
				setError(err instanceof Error ? err.message : 'Failed to complete vaerksted sign-in')
			})
	}, [])

	const handleSubmit = async (e: React.FormEvent) => {
		e.preventDefault()
		const trimmedName = name.trim()
		const trimmedOrg = organization.trim()
		const trimmedRole = role.trim()
		if (!trimmedName) {
			setError('Name is required')
			return
		}
		if (!trimmedOrg) {
			setError('Organization is required')
			return
		}
		if (!trimmedRole) {
			setError('Role is required')
			return
		}
		if (!email.trim()) {
			setError('Email is required')
			return
		}
		setError('')
		try {
			await sendMagicLink(email.trim(), {
				name: trimmedName,
				organization: trimmedOrg,
				role: trimmedRole,
			})
			setSent(true)
		} catch (err) {
			setError(err instanceof Error ? err.message : 'Failed to start sign-in')
		}
	}

	return (
		<div className="flex min-h-screen items-center justify-center">
			<div className="w-full max-w-sm space-y-6">
				<div className="text-center">
					<h1 className="text-2xl font-semibold tracking-tight">Create account</h1>
					<p className="mt-1 text-sm text-muted-foreground">Set up your workspace</p>
				</div>

				<form onSubmit={handleSubmit} className="space-y-4">
					<div>
						<Label className="mb-1 text-muted-foreground">Name</Label>
						<Input
							type="text"
							value={name}
							onChange={(e) => {
								setName(e.target.value)
								setError('')
							}}
							placeholder="Your name"
							autoFocus
							disabled={sent}
						/>
					</div>

					<div>
						<Label className="mb-1 text-muted-foreground">Organization</Label>
						<Input
							type="text"
							value={organization}
							onChange={(e) => {
								setOrganization(e.target.value)
								setError('')
							}}
							placeholder="Company name"
							disabled={sent}
						/>
					</div>

					<div>
						<Label className="mb-1 text-muted-foreground">Role</Label>
						<Input
							type="text"
							value={role}
							onChange={(e) => {
								setRole(e.target.value)
								setError('')
							}}
							placeholder="What you do"
							disabled={sent}
						/>
					</div>

					<div>
						<Label className="mb-1 text-muted-foreground">Email</Label>
						<Input
							type="email"
							value={email}
							onChange={(e) => {
								setEmail(e.target.value)
								setError('')
							}}
							placeholder="you@example.com"
							disabled={sent}
						/>
					</div>

					{error && <p className="text-xs text-error">{error}</p>}

					<Button type="submit" disabled={loading || sent} className="w-full">
						{loading ? 'Sending…' : sent ? 'Check your email' : 'Create account'}
					</Button>
					{sent && !error && (
						<p className="text-center text-xs text-muted-foreground">
							We sent a sign-in link to {email.trim()}.
						</p>
					)}
				</form>

				<p className="text-center text-xs text-muted-foreground">
					Already have an account?{' '}
					<Link to="/login" className="text-primary hover:text-primary-hover">
						Sign in
					</Link>
				</p>
			</div>
		</div>
	)
}
