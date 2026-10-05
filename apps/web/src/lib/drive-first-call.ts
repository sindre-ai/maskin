import type { IntegrationResponse } from '@/lib/api'
import { DRIVE_PROVIDER } from '@/lib/drive-humans'

/** True once an agent has made a successful Drive tool call on this workspace.
 *  The Drive MCP server stamps integrations.config.first_tool_call_at on the
 *  first one, and this is the only source the UI reads for has-ingested: nothing
 *  comes from mcp_telemetry. Drive is one row per workspace at v1, so the
 *  active row is unambiguous. */
export function hasDriveIngested(integrations: IntegrationResponse[]): boolean {
	const row = integrations.find((i) => i.provider === DRIVE_PROVIDER && i.status === 'active')
	return typeof row?.config?.first_tool_call_at === 'string'
}
