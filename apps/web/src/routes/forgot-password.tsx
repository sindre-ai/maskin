import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { api } from '@/lib/api'
import { cn } from '@/lib/cn'
import { PILL_BUTTON } from '@/lib/pill-button'
import { Link, createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'

export const Route = createFileRoute('/forgot-password')({
	head: () => ({ meta: [{ title: 'Reset your password — Maskin' }] }),
	component: ForgotPasswordPage,
})

// The same message follows every submit that reaches the server, so the page never shows whether
// an email has an account.
function ForgotPasswordPage() {
	const [email, setEmail] = useState('')
	const [error, setError] = useState('')
	const [loading, setLoading] = useState(false)
	const [sent, setSent] = useState(false)

	const handleSubmit = async (e: React.FormEvent) => {
		e.preventDefault()
		if (!email.trim()) {
			setError('Email is required')
			return
		}
		setLoading(true)
		try {
			await api.auth.forgotPassword(email.trim())
			setSent(true)
		} catch {
			setError('Something went wrong. Try again in a few minutes.')
		} finally {
			setLoading(false)
		}
	}

	return (
		<div className="flex min-h-screen items-center justify-center px-4">
			<div className="w-full max-w-sm space-y-6">
				<div className="text-center">
					<h1 className="text-[26px] font-bold tracking-tight">Reset your password</h1>
					<p className="mt-1 text-sm text-muted-foreground">
						Enter your email and we'll send you a link.
					</p>
				</div>

				{sent ? (
					<output className="block text-center text-sm">
						If that email has an account, we sent a link.
					</output>
				) : (
					<form onSubmit={handleSubmit} className="space-y-4">
						<div>
							<Label className="mb-1 text-[13px] font-semibold text-foreground">Email</Label>
							<Input
								type="email"
								value={email}
								onChange={(e) => {
									setEmail(e.target.value)
									setError('')
								}}
								placeholder="you@example.com"
								autoFocus
							/>
						</div>

						{error && <p className="text-xs text-error">{error}</p>}

						<Button type="submit" disabled={loading} className={cn(PILL_BUTTON, 'w-full')}>
							{loading ? 'Sending...' : 'Send reset link'}
						</Button>
					</form>
				)}

				<p className="text-center text-xs text-muted-foreground">
					<Link to="/login" className="text-primary hover:text-primary-hover">
						Back to sign in
					</Link>
				</p>
			</div>
		</div>
	)
}
