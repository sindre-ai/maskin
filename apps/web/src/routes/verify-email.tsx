import { EmptyState } from '@/components/shared/empty-state'
import { Spinner } from '@/components/ui/spinner'
import { useVerifyEmailChange } from '@/hooks/use-auth'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useEffect, useRef } from 'react'

export const Route = createFileRoute('/verify-email')({
	component: VerifyEmailPage,
	validateSearch: (search: Record<string, unknown>) => ({
		token: typeof search.token === 'string' ? search.token : '',
	}),
})

function VerifyEmailPage() {
	const { token } = Route.useSearch()
	const navigate = useNavigate()
	const verifyEmailChange = useVerifyEmailChange()
	const startedRef = useRef(false)

	useEffect(() => {
		if (startedRef.current || !token) return
		startedRef.current = true
		verifyEmailChange.mutate({ token })
	}, [token, verifyEmailChange])

	return (
		<div className="flex min-h-screen items-center justify-center">
			<div className="w-full max-w-sm">
				{!token ? (
					<EmptyState
						title="Invalid verification link"
						description="This link is missing its verification token. Request a new email change from your profile page."
					/>
				) : verifyEmailChange.isSuccess ? (
					<EmptyState
						title="Email updated"
						description={`Your account email is now ${verifyEmailChange.data.email ?? 'updated'}.`}
						action={
							<button
								type="button"
								onClick={() => navigate({ to: '/' })}
								className="text-sm text-primary hover:text-primary-hover"
							>
								Continue to Maskin
							</button>
						}
					/>
				) : verifyEmailChange.isError ? (
					<EmptyState
						title="Verification failed"
						description={
							verifyEmailChange.error instanceof Error
								? verifyEmailChange.error.message
								: 'This link is invalid or has expired. Request a new email change from your profile page.'
						}
					/>
				) : (
					<EmptyState
						title="Verifying your email…"
						description="Hang tight, this only takes a moment."
						action={<Spinner className="size-5 text-muted-foreground" />}
					/>
				)}
			</div>
		</div>
	)
}
