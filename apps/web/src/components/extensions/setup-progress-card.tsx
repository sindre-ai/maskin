import type { ExtensionResponse } from '@/lib/api'
import { cn } from '@/lib/cn'
import { Check, Circle } from 'lucide-react'

interface Step {
	label: string
	done: boolean
}

/**
 * Setup checklist. Every step comes from the saved row: Webhook (config,
 * token and stored secret), Mapping (an external id path), and the last step
 * flips from Waiting for first delivery to Receiving once a committed delivery
 * exists in the ledger.
 */
export function SetupProgressCard({ ext }: { ext: ExtensionResponse }) {
	const webhookDone = !!ext.webhookConfig && !!ext.webhookToken && ext.hasSigningSecret
	const mappingDone = !!ext.webhookConfig?.eventMap.externalIdPath
	const receiving = ext.committedDeliveries > 0
	const steps: Step[] = [
		{ label: 'Webhook', done: webhookDone },
		{ label: 'Mapping', done: mappingDone },
	]
	const headline = receiving
		? `Receiving from ${ext.name}.`
		: webhookDone && mappingDone
			? `Ready. Waiting for ${ext.name} to fire an event.`
			: 'Finish the webhook and mapping to start receiving.'

	return (
		<section aria-label="Setup progress" className="rounded-xl border border-border bg-card p-4">
			<output className="block text-[13px] font-semibold" aria-live="polite">
				{headline}
			</output>
			<ol className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2 text-xs">
				{steps.map((s) => (
					<li key={s.label} className="flex items-center gap-1.5">
						{s.done ? (
							<Check size={14} className="text-success" aria-hidden />
						) : (
							<Circle size={14} className="text-muted-foreground" aria-hidden />
						)}
						<span className={cn(!s.done && 'text-muted-foreground')}>{s.label}</span>
						<span className="sr-only">{s.done ? 'done' : 'not done'}</span>
					</li>
				))}
				<li className="flex items-center gap-1.5">
					<span
						aria-hidden
						className={cn(
							'inline-block size-2 rounded-full',
							receiving ? 'bg-success' : 'bg-muted-foreground/50',
						)}
					/>
					<span
						className={cn(
							'rounded-full border px-2 py-0.5 text-[11px] font-semibold',
							receiving ? 'border-success/40 text-success' : 'text-muted-foreground',
						)}
					>
						{receiving ? 'Receiving' : 'Waiting for first delivery'}
					</span>
				</li>
			</ol>
		</section>
	)
}
