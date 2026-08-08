import { Button } from '@/components/ui/button'
import { useVaerkstedAuth } from '@/hooks/use-vaerksted-auth'
import { useEffect, useState } from 'react'

interface VaerkstedAuthButtonProps {
	/** The email currently typed into the surrounding login/signup form. */
	email: string
}

/**
 * "Continue with vaerksted" (vaerksted-auth-and-sync.md §8, implementation
 * plan M5) — shared between the login and signup pages. Same button, same
 * flow either way: POST /api/vaerksted-auth/link decides whether the result
 * is a login, an email-match link, or a brand-new actor (see
 * apps/dev/src/routes/vaerksted-auth.ts), so this component never needs to
 * know which page it's rendered on.
 *
 * Reuses the existing `Button` primitive plainly, per .claude/rules/frontend.md
 * — no new UI primitive, just a small piece of feature logic (the
 * magic-link send + redirect-completion flow) that's genuinely new and used
 * in exactly the two places a "log in" action exists.
 */
export function VaerkstedAuthButton({ email }: VaerkstedAuthButtonProps) {
	const { loading, sendMagicLink, completeFromRedirect } = useVaerkstedAuth()
	const [sent, setSent] = useState(false)
	const [error, setError] = useState('')

	// Handles the return trip: a magic-link click or OAuth redirect lands back
	// on whichever page rendered this button, with a Supabase session already
	// established. No-ops when there's no pending session (the common case).
	// biome-ignore lint/correctness/useExhaustiveDependencies: intentionally run once on mount only — completeFromRedirect is stable across renders (useCallback) but re-running it on every render would re-check the Supabase session unnecessarily.
	useEffect(() => {
		completeFromRedirect().catch((err) => {
			setError(err instanceof Error ? err.message : 'Failed to complete vaerksted sign-in')
		})
	}, [])

	const handleClick = async () => {
		setError('')
		if (!email.trim()) {
			setError('Enter your email above, then continue with vaerksted')
			return
		}
		try {
			await sendMagicLink(email.trim())
			setSent(true)
		} catch (err) {
			setError(err instanceof Error ? err.message : 'Failed to start vaerksted sign-in')
		}
	}

	return (
		<div className="space-y-2">
			<Button
				type="button"
				variant="outline"
				className="w-full"
				disabled={loading || sent}
				onClick={handleClick}
			>
				{loading ? 'Starting…' : sent ? 'Check your email' : 'Continue with vaerksted'}
			</Button>
			{sent && !error && (
				<p className="text-center text-xs text-muted-foreground">
					We sent a sign-in link to {email.trim()}.
				</p>
			)}
			{error && <p className="text-center text-xs text-error">{error}</p>}
		</div>
	)
}
