import { Button } from '@/components/ui/button'
import { cn } from '@/lib/cn'
import { pushFaroError } from '@/lib/faro'
import { captureException } from '@/lib/sentry'
import { useRouter } from '@tanstack/react-router'
import { useEffect, useRef } from 'react'

// Compact variant is used inline in retry flows (see `QueryStateError`) — an
// error that a refetch resolves inside this window is never reported.
const COMPACT_CAPTURE_DELAY_MS = 3000

// React catches render errors before they reach window.onerror, so Faro's
// ErrorsInstrumentation never sees them — an error boundary is the only place
// this class of error can be reported from. Both SDKs are notified here for
// the same reason they both run in main.tsx: the Faro-vs-Sentry comparison is
// only meaningful if they see the same errors. See lib/faro.ts.
function report(error: Error): void {
	captureException(error)
	pushFaroError(error)
}

export function RouteError({
	error,
	compact,
	title = 'Something went wrong',
	onRetry,
	className,
}: {
	error: Error
	/** Inline variant for panels — no min-h, no vertical centering, tighter spacing. */
	compact?: boolean
	title?: string
	/** Override the default `router.invalidate()` retry (e.g. `query.refetch`). */
	onRetry?: () => void
	className?: string
}) {
	const router = useRouter()
	const capturedRef = useRef<Error | null>(null)

	useEffect(() => {
		if (capturedRef.current === error) return

		if (compact) {
			const timer = window.setTimeout(() => {
				report(error)
				capturedRef.current = error
			}, COMPACT_CAPTURE_DELAY_MS)
			return () => window.clearTimeout(timer)
		}

		report(error)
		capturedRef.current = error
	}, [error, compact])

	const handleRetry = () => {
		if (onRetry) onRetry()
		else router.invalidate()
	}

	if (compact) {
		return (
			<div className={cn('py-8 text-center', className)}>
				<p className="text-sm font-medium text-foreground">{title}</p>
				<p className="mt-1 text-xs text-muted-foreground">{error.message}</p>
				<Button variant="outline" size="sm" onClick={handleRetry} className="mt-3">
					Try again
				</Button>
			</div>
		)
	}

	return (
		<div className={cn('flex min-h-[50vh] items-center justify-center', className)}>
			<div className="text-center space-y-4 max-w-md">
				<h2 className="text-lg font-semibold text-foreground">{title}</h2>
				<p className="text-sm text-muted-foreground">{error.message}</p>
				<Button onClick={handleRetry}>Try again</Button>
			</div>
		</div>
	)
}
