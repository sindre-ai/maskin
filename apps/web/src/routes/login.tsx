import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useVaerkstedAuth } from '@/hooks/use-vaerksted-auth'
import { Link, createFileRoute } from '@tanstack/react-router'
import { useEffect, useState } from 'react'

export const Route = createFileRoute('/login')({
	component: LoginPage,
})

function LoginPage() {
	const { loading, sendMagicLink, completeFromRedirect } = useVaerkstedAuth()
	const [email, setEmail] = useState('')
	const [sent, setSent] = useState(false)
	const [error, setError] = useState('')

	// Completes the magic-link round trip (vaerksted-auth-and-sync.md §6/§8) —
	// no-ops when there's no pending Supabase session, the common case for a
	// normal page load.
	// biome-ignore lint/correctness/useExhaustiveDependencies: intentionally run once on mount only.
	useEffect(() => {
		completeFromRedirect().catch((err) => {
			setError(err instanceof Error ? err.message : 'Failed to complete vaerksted sign-in')
		})
	}, [])

	const handleSubmit = async (e: React.FormEvent) => {
		e.preventDefault()
		if (!email.trim()) {
			setError('Email is required')
			return
		}
		setError('')
		try {
			await sendMagicLink(email.trim())
			setSent(true)
		} catch (err) {
			setError(err instanceof Error ? err.message : 'Failed to start sign-in')
		}
	}

	return (
		<div className="flex min-h-screen items-center justify-center">
			<div className="w-full max-w-sm space-y-6">
				<div className="text-center">
					<h1 className="text-2xl font-semibold tracking-tight">Welcome back</h1>
					<p className="mt-1 text-sm text-muted-foreground">Sign in with your email</p>
				</div>

				<form onSubmit={handleSubmit} className="space-y-4">
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
							autoFocus
							disabled={sent}
						/>
					</div>

					{error && <p className="text-xs text-error">{error}</p>}

					<Button type="submit" disabled={loading || sent} className="w-full">
						{loading ? 'Sending…' : sent ? 'Check your email' : 'Sign in'}
					</Button>
					{sent && !error && (
						<p className="text-center text-xs text-muted-foreground">
							We sent a sign-in link to {email.trim()}.
						</p>
					)}
				</form>

				<p className="text-center text-xs text-muted-foreground">
					Don't have an account?{' '}
					<Link to="/signup" className="text-primary hover:text-primary-hover">
						Sign up
					</Link>
				</p>
			</div>
		</div>
	)
}
