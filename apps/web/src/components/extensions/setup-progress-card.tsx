import { mcpReady } from '@/components/extensions/mcp-form'
import type { ExtensionResponse } from '@/lib/api'
import { cn } from '@/lib/cn'
import { allowedToolNames, declaredTools } from '@/lib/extension-grants'
import { Check, Circle } from 'lucide-react'

interface Step {
	label: string
	done: boolean
}

/**
 * Setup checklist. Every step comes from the saved row: MCP (a config, plus a
 * stored key when it needs one; shown once the extension has an MCP or has no
 * webhook), Webhook (config,
 * token and stored secret), Mapping (an external id path), Access (an agent
 * holds at least one allowed tool; shown once the extension declares tools),
 * and the last step flips from Waiting for first delivery to Receiving once a
 * committed delivery exists in the ledger.
 */
export function SetupProgressCard({ ext }: { ext: ExtensionResponse }) {
	const hasMcp = !!ext.mcpConfig
	const mcpOnly = hasMcp && !ext.webhookConfig
	const webhookDone = !!ext.webhookConfig && !!ext.webhookToken && ext.hasSigningSecret
	const mappingDone = !!ext.webhookConfig?.eventMap.externalIdPath
	const receiving = ext.committedDeliveries > 0
	const steps: Step[] = []
	if (hasMcp || !ext.webhookConfig) steps.push({ label: 'MCP', done: mcpReady(ext) })
	if (!mcpOnly) {
		steps.push({ label: 'Webhook', done: webhookDone }, { label: 'Mapping', done: mappingDone })
	}
	if (declaredTools(ext).length > 0) {
		const accessDone = Object.keys(ext.toolGrants).some(
			(agentId) => allowedToolNames(ext, agentId).length > 0,
		)
		steps.push({ label: 'Access', done: accessDone })
	}
	const headline = mcpOnly
		? mcpReady(ext)
			? `${ext.name} tools are ready. Grant agents access below.`
			: 'Finish the MCP to attach its tools.'
		: receiving
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
				{!mcpOnly && (
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
				)}
			</ol>
		</section>
	)
}
