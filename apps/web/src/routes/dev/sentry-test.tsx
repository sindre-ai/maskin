import { Button } from '@/components/ui/button'
import { captureException } from '@/lib/sentry'
import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'

export const Route = createFileRoute('/dev/sentry-test')({
	component: SentryTestPage,
})

// Dev-only page — the button is only wired to throw when Vite's DEV flag is
// on, or when VITE_SENTRY_FORCE_ENABLE=true (the same escape hatch the Sentry
// init uses). A production build renders the disabled state so a stray link
// can't fire a fake event against the live project.
function SentryTestPage() {
	const enabled = import.meta.env.DEV || import.meta.env.VITE_SENTRY_FORCE_ENABLE === 'true'
	const [thrown, setThrown] = useState(false)

	function trigger() {
		// captureException reaches Sentry through the same path as an uncaught
		// throw would — cheaper than raising an actual crash for a verification
		// button that only needs to produce one event.
		const error = new Error(`Sentry test exception from apps/web (${new Date().toISOString()})`)
		captureException(error)
		setThrown(true)
	}

	return (
		<div className="mx-auto flex max-w-md flex-col gap-4 p-6">
			<h1 className="font-semibold text-lg">Sentry test</h1>
			<p className="text-sm text-text-secondary">
				Fires a synthetic exception through the same Sentry client the app uses. Sentry only
				actually captures the event when a DSN is configured and the environment is production or
				<code className="mx-1 rounded bg-bg-hover px-1">VITE_SENTRY_FORCE_ENABLE=true</code>. Use
				this to verify the DSN and release wiring end-to-end.
			</p>
			<Button
				type="button"
				onClick={trigger}
				disabled={!enabled}
				aria-label="Throw a test exception through Sentry"
			>
				Throw test exception
			</Button>
			{!enabled ? (
				<p className="text-text-muted text-xs">
					Disabled: this build isn't a Vite dev build and{' '}
					<code className="rounded bg-bg-hover px-1">VITE_SENTRY_FORCE_ENABLE</code> isn't set.
				</p>
			) : null}
			{thrown ? (
				<p className="text-text-muted text-xs">
					Event dispatched. Check the Sentry project in ~30s.
				</p>
			) : null}
		</div>
	)
}
