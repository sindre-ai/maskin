import { ActivityFeedView } from '@/components/activity/activity-feed'
import { useToolResult } from '../shared/mcp-app-provider'
import { renderMcpApp } from '../shared/render'
import type { EventResponse } from '../shared/types'
import { WebAppLink } from '../shared/web-app-link'

function EventsApp() {
	const toolResult = useToolResult()

	if (!toolResult) {
		return <div className="p-4 text-muted-foreground text-sm">Waiting for data...</div>
	}

	const text = toolResult.result.content?.find(
		(c: { type: string; text?: string }) => c.type === 'text',
	)?.text
	if (!text) return <div className="p-4 text-muted-foreground text-sm">No data received</div>

	const data = JSON.parse(text)
	const events: EventResponse[] = data.data ?? data

	return (
		<div>
			<div className="flex justify-end p-3 pb-0">
				<WebAppLink target={{ kind: 'activity' }} label="View activity in Maskin" />
			</div>
			<ActivityFeedView events={events} />
		</div>
	)
}

renderMcpApp('Events', <EventsApp />)
