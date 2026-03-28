import { EmptyState } from '@/components/shared/empty-state'
import { useToolResult } from '../shared/mcp-app-provider'
import { renderMcpApp } from '../shared/render'
import type { TriggerResponse } from '../shared/types'

function TriggersApp() {
	const toolResult = useToolResult()

	if (!toolResult) {
		return <div className="p-4 text-muted-foreground text-sm">Waiting for data...</div>
	}

	const text = toolResult.result.content?.find(
		(c: { type: string; text?: string }) => c.type === 'text',
	)?.text
	if (!text) return <div className="p-4 text-muted-foreground text-sm">No data received</div>

	let data: Record<string, unknown>
	try {
		data = JSON.parse(text)
	} catch {
		return <div className="p-4 text-sm text-foreground">{text}</div>
	}

	switch (toolResult.toolName) {
		case 'list_triggers':
			return <TriggerListView triggers={(data.data ?? data) as TriggerResponse[]} />
		case 'create_trigger':
			return <TriggerDetailView trigger={data as unknown as TriggerResponse} />
		default:
			return <TriggerDetailView trigger={data as unknown as TriggerResponse} />
	}
}

function TriggerListView({ triggers }: { triggers: TriggerResponse[] }) {
	if (!triggers.length) {
		return <EmptyState title="No triggers" description="No automation triggers configured" />
	}

	return (
		<div className="p-4 space-y-1">
			{triggers.map((trigger) => (
				<div
					key={trigger.id}
					className="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-accent hover:text-accent-foreground transition-colors"
				>
					<span
						className={`w-2 h-2 rounded-full ${trigger.enabled ? 'bg-success' : 'bg-muted-foreground'}`}
					/>
					<span className="text-sm text-foreground flex-1">{trigger.name}</span>
					<span className="text-xs text-muted-foreground capitalize">{trigger.type}</span>
				</div>
			))}
		</div>
	)
}

function TriggerDetailView({ trigger }: { trigger: TriggerResponse }) {
	return (
		<div className="p-4 max-w-2xl">
			<div className="flex items-center gap-2 mb-2">
				<span
					className={`w-2 h-2 rounded-full ${trigger.enabled ? 'bg-success' : 'bg-muted-foreground'}`}
				/>
				<h1 className="text-lg font-semibold text-foreground">{trigger.name}</h1>
			</div>
			<div className="text-xs text-muted-foreground mb-4 capitalize">
				Type: {trigger.type} | {trigger.enabled ? 'Enabled' : 'Disabled'}
			</div>
			{trigger.actionPrompt && (
				<div className="border-t border-border pt-3 mt-3">
					<h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground mb-2">
						Action Prompt
					</h3>
					<p className="text-sm text-muted-foreground whitespace-pre-wrap">
						{trigger.actionPrompt}
					</p>
				</div>
			)}
			{trigger.config && Object.keys(trigger.config).length > 0 && (
				<div className="border-t border-border pt-3 mt-3">
					<h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground mb-2">
						Config
					</h3>
					<div className="space-y-1.5">
						{Object.entries(trigger.config).map(([key, value]) => (
							<div key={key} className="flex gap-2 text-xs">
								<span className="text-muted-foreground font-medium min-w-[100px]">
									{key.replace(/_/g, ' ')}
								</span>
								<span className="text-foreground">
									{typeof value === 'object' && value !== null
										? Array.isArray(value)
											? value.join(', ')
											: JSON.stringify(value)
										: String(value)}
								</span>
							</div>
						))}
					</div>
				</div>
			)}
		</div>
	)
}

renderMcpApp('Triggers', <TriggersApp />)
