import { EmptyState } from '@/components/shared/empty-state'
import { Spinner } from '@/components/ui/spinner'
import { useVerifyEmailChange } from '@/hooks/use-auth'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'

export const Route = createFileRoute('/verify-email')({
	component: VerifyEmailPage,
	validateSearch: (search: Record<string, unknown>) => ({
		token: typeof search.token === 'string' ? search.token : '',
	}),
})

type VerifyState =
	| { status: 'pending' }
	| { status: 'success'; email: string | null }
	| { status: 'error'; message: string }

const DEFAULT_ERROR_MESSAGE =
	'This link is invalid or has expired. Request a new email change from your profile page.'

function VerifyEmailPage() {
	const { token } = Route.useSearch()
	const navigate = useNavigate()
	const verifyEmailChange = useVerifyEmailChange()
	const startedRef = useRef(false)
	const [state, setState] = useState<VerifyState>({ status: 'pending' })

	// Drive rendering off mutateAsync's own promise rather than the mutation's
	// isSuccess/isError — under React StrictMode, kicking a mutation off in an
	// effect can tear down and rebuild the observer's subscription while the
	// request is in flight, so its reactive state update never reaches this
	// render. Awaiting the promise directly sidesteps that subscription path.
	// biome-ignore lint/correctness/useExhaustiveDependencies: verifyEmailChange's identity changes on every status transition; startedRef guards against re-invoking mutateAsync
	useEffect(() => {
		if (startedRef.current || !token) return
		startedRef.current = true
		verifyEmailChange
			.mutateAsync({ token })
			.then((result) => setState({ status: 'success', email: result.email }))
			.catch((error) =>
				setState({
					status: 'error',
					message: error instanceof Error ? error.message : DEFAULT_ERROR_MESSAGE,
				}),
			)
	}, [token])

	return (
		<div className="flex min-h-screen items-center justify-center">
			<div className="w-full max-w-sm">
				{!token ? (
					<EmptyState
						title="Invalid verification link"
						description="This link is missing its verification token. Request a new email change from your profile page."
					/>
				) : state.status === 'success' ? (
					<EmptyState
						title="Email updated"
						description={`Your account email is now ${state.email ?? 'updated'}.`}
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
				) : state.status === 'error' ? (
					<EmptyState title="Verification failed" description={state.message} />
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
