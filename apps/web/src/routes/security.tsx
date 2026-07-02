import { Link, createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/security')({
	component: SecurityPage,
})

// Gated on VITE_SOC2_OBSERVATION_UNDERWAY. The commit that flips this to true
// is the timestamp we point to for "observation period underway" — do not
// flip until Vanta observation has actually begun.
function isObservationUnderway(): boolean {
	return import.meta.env.VITE_SOC2_OBSERVATION_UNDERWAY === 'true'
}

function SecurityPage() {
	const observationUnderway = isObservationUnderway()

	return (
		<div className="mx-auto flex min-h-screen max-w-2xl flex-col gap-10 px-6 py-16">
			<header className="space-y-3">
				<Link to="/" className="text-xs text-muted-foreground hover:text-foreground">
					Maskin
				</Link>
				<h1 className="text-3xl font-semibold tracking-tight">Security</h1>
				<p className="text-sm text-muted-foreground">
					How we think about protecting the data you entrust to Maskin.
				</p>
			</header>

			<section className="space-y-3">
				<h2 className="text-lg font-medium">Compliance owner</h2>
				<p className="text-sm text-foreground">
					Magnus is our compliance owner of record. For security or compliance questions, including
					SOC 2 documentation requests, reach out to{' '}
					<a href="mailto:security@maskin.io" className="text-primary hover:text-primary-hover">
						security@maskin.io
					</a>
					.
				</p>
			</section>

			<section className="space-y-3">
				<h2 className="text-lg font-medium">SOC 2 Type II</h2>
				{observationUnderway ? (
					<p className="text-sm text-foreground">
						SOC 2 Type II observation period underway. Bridge letters and interim reports are
						available on request under NDA.
					</p>
				) : (
					<p className="text-sm text-muted-foreground">
						SOC 2 Type II scope is under configuration. We will publish observation status on this
						page once the observation period begins.
					</p>
				)}
			</section>
		</div>
	)
}
