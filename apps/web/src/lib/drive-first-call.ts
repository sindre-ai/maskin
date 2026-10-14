import type { IntegrationResponse } from '@/lib/api'
import { DRIVE_PROVIDER } from '@/lib/drive-humans'

/** True once an agent has made a successful Drive tool call on this workspace.
 *  The Drive MCP server stamps integrations.config.first_tool_call_at on the
 *  first one, and this is the only source the UI reads for has-ingested: nothing
 *  comes from mcp_telemetry. The Drive tools resolve one unordered Drive row, so
 *  the stamp can sit on any active row: check all of them, not the first. */
export function hasDriveIngested(integrations: IntegrationResponse[]): boolean {
	return integrations.some(
		(i) =>
			i.provider === DRIVE_PROVIDER &&
			i.status === 'active' &&
			typeof i.config?.first_tool_call_at === 'string',
	)
}
