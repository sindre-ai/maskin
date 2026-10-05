import { McpTag } from '@/components/integrations/drive/mcp-tag'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { DRIVE_SCOPES } from '@/lib/drive-humans'
import { DRIVE_WIZARD_COPY, DRIVE_WIZARD_SCOPE_DESCRIPTIONS } from '@/lib/drive-wizard-copy'

export type ConnectWizardState = 'default' | 'loading' | 'error'

/** The three-step Drive connect wizard a fresh admin sees before any Google
 *  row exists. One scope row per scope the connect route requests, so adding a
 *  scope later is a DRIVE_SCOPES row plus its description in the wizard copy. */
export function ConnectWizard({
	state,
	onContinue,
	onCancel,
}: {
	state: ConnectWizardState
	onContinue: () => void
	onCancel: () => void
}) {
	const loading = state === 'loading'
	return (
		<section
			className="mx-auto w-full max-w-lg overflow-hidden rounded-xl border border-border bg-bg-surface"
			aria-labelledby="drive-wizard-title"
			data-testid="drive-connect-wizard"
			data-state={state}
		>
			<div className="space-y-3 p-5 pb-4">
				<img
					src="/integrations/google-drive.svg"
					alt=""
					aria-hidden="true"
					className="h-12 w-12 rounded-md"
				/>
				<h3 id="drive-wizard-title" className="text-lg font-semibold text-foreground">
					{DRIVE_WIZARD_COPY.title}
				</h3>
				<p className="text-sm text-muted-foreground">{DRIVE_WIZARD_COPY.body}</p>
			</div>

			<div className="space-y-4 px-5 pb-5">
				<ol className="space-y-2.5">
					{DRIVE_WIZARD_COPY.steps.map((step, i) => (
						<li key={step.lead} className="flex gap-2.5 text-sm text-foreground">
							<span
								className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary/10 text-[11px] font-semibold text-primary"
								aria-hidden="true"
							>
								{i + 1}
							</span>
							<span>
								<strong className="font-semibold">{step.lead}</strong>
								{step.text}
								{'textAfter' in step && (
									<>
										<McpTag />
										{step.textAfter}
									</>
								)}
							</span>
						</li>
					))}
				</ol>

				<div
					className="space-y-1.5 rounded-md border border-border bg-bg-base p-3 text-xs text-muted-foreground"
					data-testid="drive-wizard-scopes"
				>
					<p className="font-semibold text-foreground">{DRIVE_WIZARD_COPY.scopesTitle}</p>
					<ul className="space-y-1.5">
						{DRIVE_SCOPES.map((s) => (
							<li key={s.scope} className="flex gap-2">
								<span className="w-3 shrink-0 font-semibold text-primary" aria-hidden="true">
									+
								</span>
								<span>
									<strong className="font-medium text-foreground">{s.label}</strong>
									{DRIVE_WIZARD_SCOPE_DESCRIPTIONS[s.scope]}{' '}
									<code className="font-mono text-[11px] text-primary">{s.sublabel}</code>
								</span>
							</li>
						))}
					</ul>
				</div>

				{state === 'error' && (
					<p
						role="alert"
						className="rounded-md border border-error/40 bg-error/10 p-3 text-sm text-error"
						data-testid="drive-wizard-error"
					>
						{DRIVE_WIZARD_COPY.error}
					</p>
				)}
			</div>

			<div className="flex flex-wrap justify-between gap-2 border-t border-border bg-bg-base px-5 py-3">
				<Button variant="ghost" size="sm" onClick={onCancel} disabled={loading}>
					{DRIVE_WIZARD_COPY.cancel}
				</Button>
				<Button size="sm" onClick={onContinue} disabled={loading} aria-busy={loading}>
					{loading ? (
						<>
							<Spinner aria-hidden="true" />
							{DRIVE_WIZARD_COPY.loading}
						</>
					) : (
						DRIVE_WIZARD_COPY.continue
					)}
				</Button>
			</div>
		</section>
	)
}
