import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useAuth } from '@/hooks/use-auth'
import { trackEvent } from '@/lib/analytics'
import { api } from '@/lib/api'
import { buildSignupCaptureKnowledge } from '@maskin/shared'
import { Link, createFileRoute } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'

export const Route = createFileRoute('/signup')({
	component: SignupPage,
})

function SignupPage() {
	const { signup } = useAuth()
	const [name, setName] = useState('')
	const [organization, setOrganization] = useState('')
	const [role, setRole] = useState('')
	const [email, setEmail] = useState('')
	const [password, setPassword] = useState('')
	const [confirmPassword, setConfirmPassword] = useState('')
	const [error, setError] = useState('')
	const [loading, setLoading] = useState(false)

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
		if (password.length < 8) {
			setError('Password must be at least 8 characters')
			return
		}
		if (password !== confirmPassword) {
			setError('Passwords do not match')
			return
		}
		setLoading(true)
		try {
			const anonId = localStorage.getItem('maskin_anon_id')
			const result = await signup({
				type: 'human',
				name: trimmedName,
				email: email.trim(),
				password,
			})
			const actorId = result?.id
			const workspaceId = result?.workspace_id
			if (workspaceId) {
				try {
					const payload = buildSignupCaptureKnowledge({
						name: trimmedName,
						organization: trimmedOrg,
						role: trimmedRole,
					})
					await api.objects.create(workspaceId, payload)
					console.info('[maskin] wrote signup capture knowledge', {
						workspaceId,
						actorId,
					})
				} catch (err) {
					console.error('[maskin] failed to write signup capture knowledge', err)
				}
			} else {
				console.warn('[maskin] no workspace_id returned from signup; skipping capture write')
			}
			if (!actorId) {
				console.error(
					'[maskin] signup succeeded but returned no actor id; skipping submitted event',
				)
			} else {
				trackEvent('signup_form_submitted', {
					user_id: actorId,
					completed: true,
				})
			}
			if (anonId) {
				api.landingEvents
					.emit([{ name: 'signup_complete', anonId, props: { fromGuest: true } }])
					.catch(() => console.error('[maskin] failed to emit signup_complete'))
			}
			window.location.assign('/')
		} catch (err) {
			setError(err instanceof Error ? err.message : 'Signup failed')
		} finally {
			setLoading(false)
		}
	}

	return (
		<div className="flex min-h-screen items-center justify-center">
			<div className="w-full max-w-sm space-y-[var(--space-6)]">
				<div className="text-center">
					<h1 className="text-display font-semibold ">Create account</h1>
					<p className="mt-[var(--space-1)] text-label text-muted-foreground">
						Set up your workspace
					</p>
				</div>

				<form onSubmit={handleSubmit} className="space-y-[var(--space-4)]">
					<div>
						<Label className="mb-[var(--space-1)] text-muted-foreground">Name</Label>
						<Input
							type="text"
							value={name}
							onChange={(e) => {
								setName(e.target.value)
								setError('')
							}}
							placeholder="Your name"
							autoFocus
						/>
					</div>

					<div>
						<Label className="mb-[var(--space-1)] text-muted-foreground">Organization</Label>
						<Input
							type="text"
							value={organization}
							onChange={(e) => {
								setOrganization(e.target.value)
								setError('')
							}}
							placeholder="Company name"
						/>
					</div>

					<div>
						<Label className="mb-[var(--space-1)] text-muted-foreground">Role</Label>
						<Input
							type="text"
							value={role}
							onChange={(e) => {
								setRole(e.target.value)
								setError('')
							}}
							placeholder="What you do"
						/>
					</div>

					<div>
						<Label className="mb-[var(--space-1)] text-muted-foreground">Email</Label>
						<Input
							type="email"
							value={email}
							onChange={(e) => {
								setEmail(e.target.value)
								setError('')
							}}
							placeholder="you@example.com"
						/>
					</div>

					<div>
						<Label className="mb-[var(--space-1)] text-muted-foreground">Password</Label>
						<Input
							type="password"
							value={password}
							onChange={(e) => {
								setPassword(e.target.value)
								setError('')
							}}
							placeholder="At least 8 characters"
						/>
					</div>

					<div>
						<Label className="mb-[var(--space-1)] text-muted-foreground">Confirm password</Label>
						<Input
							type="password"
							value={confirmPassword}
							onChange={(e) => {
								setConfirmPassword(e.target.value)
								setError('')
							}}
							placeholder="Repeat your password"
						/>
					</div>

					{error && <p className="text-caption text-error">{error}</p>}

					<Button type="submit" disabled={loading} className="w-full">
						{loading ? 'Creating...' : 'Create account'}
					</Button>
				</form>

				<p className="text-center text-caption text-muted-foreground">
					Already have an account?{' '}
					<Link to="/login" className="text-primary hover:text-primary-hover">
						Sign in
					</Link>
				</p>
			</div>
		</div>
	)
}
