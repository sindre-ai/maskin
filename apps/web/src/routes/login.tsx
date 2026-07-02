import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useAuth } from '@/hooks/use-auth'
import { Link, createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'

export const Route = createFileRoute('/login')({
	component: LoginPage,
})

function LoginPage() {
	const { login } = useAuth()
	const [email, setEmail] = useState('')
	const [password, setPassword] = useState('')
	const [error, setError] = useState('')
	const [loading, setLoading] = useState(false)

	const handleSubmit = async (e: React.FormEvent) => {
		e.preventDefault()
		if (!email.trim()) {
			setError('Email is required')
			return
		}
		if (!password) {
			setError('Password is required')
			return
		}
		setLoading(true)
		try {
			await login({ email: email.trim(), password })
		} catch (err) {
			setError(err instanceof Error ? err.message : 'Login failed')
		} finally {
			setLoading(false)
		}
	}

	return (
		<div className="flex min-h-screen items-center justify-center">
			<div className="w-full max-w-sm space-y-[var(--space-6)]">
				<div className="text-center">
					<h1 className="text-display font-semibold ">Welcome back</h1>
					<p className="mt-[var(--space-1)] text-label text-muted-foreground">
						Sign in with your email and password
					</p>
				</div>

				<form onSubmit={handleSubmit} className="space-y-[var(--space-4)]">
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
							autoFocus
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
							placeholder="Your password"
						/>
					</div>

					{error && <p className="text-caption text-error">{error}</p>}

					<Button type="submit" disabled={loading} className="w-full">
						{loading ? 'Signing in...' : 'Sign in'}
					</Button>
				</form>

				<p className="text-center text-caption text-muted-foreground">
					Don't have an account?{' '}
					<Link to="/signup" className="text-primary hover:text-primary-hover">
						Sign up
					</Link>
				</p>
			</div>
		</div>
	)
}
