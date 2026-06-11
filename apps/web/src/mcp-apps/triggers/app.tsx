import { EmptyState } from '@/components/shared/empty-state'
import { useToolResult } from '../shared/mcp-app-provider'
import { isArray, isObject, safeParseJson, unwrapEnvelope } from '../shared/parse'
import { renderMcpApp } from '../shared/render'
import type { TriggerResponse } from '../shared/types'
import { WebAppLink, useWebAppHref } from '../shared/web-app-link'

function TriggersApp() {
	const toolResult = useToolResult()

	if (!toolResult) {
		return <div className="p-4 text-muted-foreground text-sm">Waiting for data...</div>
	}

	const text = toolResult.result.content?.find(
		(c: { type: string; text?: string }) => c.type === 'text',
	)?.text
	if (!text) return <div className="p-4 text-muted-foreground text-sm">No data received</div>

	const data = safeParseJson(text)
	if (!data) return <div className="p-4 text-sm text-foreground">{text}</div>

	const unwrapped = unwrapEnvelope(data)

	switch (toolResult.toolName) {
		case 'list_triggers':
			return isArray(unwrapped) ? (
				<TriggerListView triggers={unwrapped as TriggerResponse[]} />
			) : (
				<div className="p-4 text-sm text-foreground">{text}</div>
			)
		case 'create_trigger':
		case 'update_trigger':
			return isObject<TriggerResponse>(data, 'id', 'name') ? (
				<TriggerDetailView trigger={data} />
			) : (
				<div className="p-4 text-sm text-foreground">{text}</div>
			)
		case 'delete_trigger':
			return <TriggerDeletedView />
		default:
			return isObject<TriggerResponse>(data, 'id', 'name') ? (
				<TriggerDetailView trigger={data} />
			) : (
				<div className="p-4 text-sm text-foreground">{text}</div>
			)
	}
}

function TriggerListView({ triggers }: { triggers: TriggerResponse[] }) {
	if (!triggers.length) {
		return <EmptyState title="No triggers" description="No automation triggers configured" />
	}

	return (
		<div className="p-4 space-y-1">
			{triggers.map((trigger) => (
				<TriggerListRow key={trigger.id} trigger={trigger} />
			))}
		</div>
	)
}

function TriggerListRow({ trigger }: { trigger: TriggerResponse }) {
	const href = useWebAppHref({ kind: 'trigger', id: trigger.id })
	const content = (
		<>
			<span
				className={`w-2 h-2 rounded-full ${trigger.enabled ? 'bg-success' : 'bg-muted-foreground'}`}
			/>
			<span className="text-sm text-foreground flex-1">{trigger.name}</span>
			<span className="text-xs text-muted-foreground capitalize">{trigger.type}</span>
		</>
	)
	if (!href) return <div className="flex items-center gap-3 px-3 py-2 rounded-lg">{content}</div>
	return (
		<a
			href={href}
			target="_blank"
			rel="noreferrer"
			className="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-accent hover:text-accent-foreground transition-colors no-underline"
		>
			{content}
		</a>
	)
}

function TriggerDetailView({ trigger }: { trigger: TriggerResponse }) {
	return (
		<div className="p-4 max-w-2xl">
			<div className="flex items-start justify-between gap-3 mb-2">
				<div className="flex items-center gap-2 min-w-0">
					<span
						className={`w-2 h-2 rounded-full ${trigger.enabled ? 'bg-success' : 'bg-muted-foreground'}`}
					/>
					<h1 className="text-lg font-semibold text-foreground truncate">{trigger.name}</h1>
				</div>
				<WebAppLink target={{ kind: 'trigger', id: trigger.id }} />
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

function TriggerDeletedView() {
	return (
		<div className="p-4 text-center">
			<p className="text-sm text-muted-foreground">Trigger deleted successfully.</p>
		</div>
	)
}

renderMcpApp('Triggers', <TriggersApp />)
