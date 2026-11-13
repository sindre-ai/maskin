import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ApiError, api } from '@/lib/api'
import { cn } from '@/lib/cn'
import { PILL_BUTTON } from '@/lib/pill-button'
import { Link, createFileRoute, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'

export const Route = createFileRoute('/reset-password')({
	validateSearch: (search: Record<string, unknown>) => ({
		token: typeof search.token === 'string' ? search.token : '',
	}),
	head: () => ({ meta: [{ title: 'Choose a new password — Maskin' }] }),
	component: ResetPasswordPage,
})

// The reset email links to /reset-password?token=…; the token is the only credential on the page,
// so it is never rendered or logged, only sent to the one reset call below.

// Same floor as signup.
const MIN_PASSWORD_LENGTH = 8

function ResetPasswordPage() {
	const { token } = Route.useSearch()
	const navigate = useNavigate()
	const [password, setPassword] = useState('')
	const [confirm, setConfirm] = useState('')
	const [error, setError] = useState('')
	const [loading, setLoading] = useState(false)

	const handleSubmit = async (e: React.FormEvent) => {
		e.preventDefault()
		if (password.length < MIN_PASSWORD_LENGTH) {
			setError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`)
			return
		}
		if (password !== confirm) {
			setError('Passwords do not match')
			return
		}
		setLoading(true)
		try {
			await api.auth.resetPassword({ token, password })
			await navigate({ to: '/login', search: {} })
		} catch (err) {
			setError(
				err instanceof ApiError && err.status === 400
					? 'This reset link is invalid or has expired. Ask for a new one.'
					: 'Something went wrong. Try again in a few minutes.',
			)
		} finally {
			setLoading(false)
		}
	}

	return (
		<div className="flex min-h-screen items-center justify-center px-4">
			<div className="w-full max-w-sm space-y-6">
				<div className="text-center">
					<h1 className="text-[26px] font-bold tracking-tight">Choose a new password</h1>
					<p className="mt-1 text-sm text-muted-foreground">You'll sign in with it next.</p>
				</div>

				{token ? (
					<form onSubmit={handleSubmit} className="space-y-4">
						<div>
							<Label className="mb-1 text-[13px] font-semibold text-foreground">New password</Label>
							<Input
								type="password"
								value={password}
								onChange={(e) => {
									setPassword(e.target.value)
									setError('')
								}}
								placeholder="At least 8 characters"
								autoComplete="new-password"
								autoFocus
							/>
						</div>
						<div>
							<Label className="mb-1 text-[13px] font-semibold text-foreground">
								Confirm password
							</Label>
							<Input
								type="password"
								value={confirm}
								onChange={(e) => {
									setConfirm(e.target.value)
									setError('')
								}}
								placeholder="Type it again"
								autoComplete="new-password"
							/>
						</div>

						{error && <p className="text-xs text-error">{error}</p>}

						<Button type="submit" disabled={loading} className={cn(PILL_BUTTON, 'w-full')}>
							{loading ? 'Saving...' : 'Set new password'}
						</Button>
					</form>
				) : (
					<p className="text-center text-sm text-muted-foreground">
						This reset link is incomplete. Ask for a new one.
					</p>
				)}

				<p className="text-center text-xs text-muted-foreground">
					<Link to="/forgot-password" className="text-primary hover:text-primary-hover">
						Send a new link
					</Link>
					{' · '}
					<Link to="/login" className="text-primary hover:text-primary-hover">
						Back to sign in
					</Link>
				</p>
			</div>
		</div>
	)
}
