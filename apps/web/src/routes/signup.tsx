import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useAuth } from '@/hooks/use-auth'
import { api } from '@/lib/api'
import { Link, createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'

export const Route = createFileRoute('/signup')({
	component: SignupPage,
})

// Signup → guest-draft handoff:
// When a visitor drafted a bet on the landing page (sindre.ai) and clicks the
// "Save this bet — sign up" CTA, the centre.ai page sends them here with
// `?claim=1`. After signup, we POST to /api/public/bet-strategist/claim with
// the new actor's bearer + workspace_id; the server reads the HttpOnly guest
// cookie (set by /drafts during the visitor's prompt) and copies the draft
// into the new workspace. Failure is non-fatal — the account is created
// either way; the user just keeps the draft on the landing page.
function shouldClaimGuestDraft(): boolean {
	if (typeof window === 'undefined') return false
	return new URLSearchParams(window.location.search).get('claim') === '1'
}

function SignupPage() {
	const { signup } = useAuth()
	const [name, setName] = useState('')
	const [email, setEmail] = useState('')
	const [password, setPassword] = useState('')
	const [confirmPassword, setConfirmPassword] = useState('')
	const [error, setError] = useState('')
	const [loading, setLoading] = useState(false)

	const handleSubmit = async (e: React.FormEvent) => {
		e.preventDefault()
		if (!name.trim()) {
			setError('Name is required')
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
			const result = await signup({
				type: 'human',
				name: name.trim(),
				email: email.trim(),
				password,
			})
			if (shouldClaimGuestDraft() && result?.workspace_id) {
				try {
					const { claimed } = await api.publicBetStrategist.claim(result.workspace_id)
					console.info('[maskin] guest draft claim', { count: claimed.length })
				} catch (claimErr) {
					// Non-fatal: signup succeeded; surface in logs so a recurring
					// claim failure shows up in observability.
					console.error('[maskin] guest draft claim failed', claimErr)
				}
			}
		} catch (err) {
			setError(err instanceof Error ? err.message : 'Signup failed')
		} finally {
			setLoading(false)
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
						/>
					</div>

					<div>
						<Label className="mb-1 text-muted-foreground">Password</Label>
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
						<Label className="mb-1 text-muted-foreground">Confirm password</Label>
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

					{error && <p className="text-xs text-error">{error}</p>}

					<Button type="submit" disabled={loading} className="w-full">
						{loading ? 'Creating...' : 'Create account'}
					</Button>
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
