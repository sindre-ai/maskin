import { ActivityFeedView } from '@/components/activity/activity-feed'
import { parseToolData, useToolResult } from '../shared/mcp-app-provider'
import { renderMcpApp } from '../shared/render'
import type { EventResponse } from '../shared/types'

function EventsApp() {
	const toolResult = useToolResult()

	if (!toolResult) {
		return <div className="p-4 text-muted-foreground text-sm">Waiting for data...</div>
	}

	// biome-ignore lint/suspicious/noExplicitAny: MCP tool data is dynamic
	const data = parseToolData(toolResult.result) as any
	if (!data) return <div className="p-4 text-muted-foreground text-sm">No data received</div>

	const events: EventResponse[] = data.data ?? data

	return <ActivityFeedView events={events} />
}

renderMcpApp('Events', <EventsApp />)
