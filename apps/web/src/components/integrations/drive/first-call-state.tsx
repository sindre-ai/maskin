import { McpTag } from '@/components/integrations/drive/mcp-tag'
import { DRIVE_FIRST_CALL_COPY } from '@/lib/drive-wizard-copy'

/** What the Drive detail page shows after connect, until an agent has made its
 *  first successful Drive call: the headline, the eight things agents can now
 *  do, and a sample of the notification a Drive event produces. */
export function FirstCallState() {
	const { sample } = DRIVE_FIRST_CALL_COPY
	return (
		<div className="mx-auto w-full max-w-5xl space-y-6" data-testid="drive-first-call">
			<div className="space-y-2 px-2 py-4 text-center">
				<div
					className="mx-auto flex h-16 w-16 items-center justify-center rounded-2xl bg-amber-100 text-2xl font-extrabold text-amber-800 dark:bg-amber-500/15 dark:text-amber-300"
					aria-hidden="true"
				>
					D
				</div>
				<h3 className="text-xl font-semibold text-foreground">{DRIVE_FIRST_CALL_COPY.headline}</h3>
				<p className="mx-auto max-w-prose text-sm text-muted-foreground">
					{DRIVE_FIRST_CALL_COPY.bodyBefore}
					<McpTag />
					{DRIVE_FIRST_CALL_COPY.bodyAfter}
				</p>
			</div>

			<div className="space-y-3">
				<p className="text-center text-xs font-medium uppercase tracking-wide text-muted-foreground">
					{DRIVE_FIRST_CALL_COPY.cardsLabel}
				</p>
				<ul
					className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4"
					data-testid="drive-jtbd-grid"
				>
					{DRIVE_FIRST_CALL_COPY.jtbds.map((card) => (
						<li
							key={card.title}
							className="rounded-lg border border-border bg-bg-surface p-3.5"
							data-testid="drive-jtbd-card"
						>
							<div className="mb-2 flex items-center gap-2">
								<span
									className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-amber-100 text-xs font-bold text-amber-800 dark:bg-amber-500/15 dark:text-amber-300"
									aria-hidden="true"
								>
									{card.glyph}
								</span>
								<h4 className="text-sm font-semibold text-foreground">{card.title}</h4>
							</div>
							<p className="text-xs text-muted-foreground">{card.description}</p>
						</li>
					))}
				</ul>
			</div>

			<section className="space-y-2" aria-label={DRIVE_FIRST_CALL_COPY.sampleLabel}>
				<p className="text-center text-xs font-medium uppercase tracking-wide text-muted-foreground">
					{DRIVE_FIRST_CALL_COPY.sampleLabel}
				</p>
				<div
					className="mx-auto flex max-w-xl gap-3 rounded-lg border border-border bg-bg-surface p-3.5"
					data-testid="drive-sample-notification"
				>
					<div
						className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-amber-100 text-sm font-bold text-amber-800 dark:bg-amber-500/15 dark:text-amber-300"
						aria-hidden="true"
					>
						D
					</div>
					<div className="min-w-0 space-y-1.5">
						<div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
							<strong className="font-semibold text-foreground">{sample.agent}</strong>
							<span>{sample.action}</span>
							<McpTag tool={sample.tool} />
							<span>{sample.time}</span>
						</div>
						<p className="text-sm text-foreground">{sample.message}</p>
						<div className="flex gap-2" aria-hidden="true">
							<span className="rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground">
								{sample.primary}
							</span>
							<span className="rounded-md px-2.5 py-1 text-xs font-medium text-muted-foreground">
								{sample.secondary}
							</span>
						</div>
					</div>
				</div>
			</section>
		</div>
	)
}
