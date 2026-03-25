import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useAuth } from '@/hooks/use-auth'
import { Link, createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'

export const Route = createFileRoute('/signup')({
	component: SignupPage,
})

function SignupPage() {
	const { signup } = useAuth()
	const [name, setName] = useState('')
	const [email, setEmail] = useState('')
	const [error, setError] = useState('')
	const [loading, setLoading] = useState(false)

	const handleSubmit = async (e: React.FormEvent) => {
		e.preventDefault()
		if (!name.trim()) {
			setError('Name is required')
			return
		}
		setLoading(true)
		try {
			await signup({
				type: 'human',
				name: name.trim(),
				email: email.trim() || undefined,
			})
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
						<Label className="mb-1 text-muted-foreground">Email (optional)</Label>
						<Input
							type="email"
							value={email}
							onChange={(e) => setEmail(e.target.value)}
							placeholder="you@example.com"
						/>
					</div>

					{error && <p className="text-xs text-error">{error}</p>}

					<Button type="submit" disabled={loading} className="w-full">
						{loading ? 'Creating...' : 'Create account'}
					</Button>
				</form>

				<p className="text-center text-xs text-muted-foreground">
					Already have a key?{' '}
					<Link to="/login" className="text-primary hover:text-primary-hover">
						Sign in
					</Link>
				</p>
			</div>
		</div>
	)
}
