/**
 * Drift check for the pinned Claude client record (MCP OAuth, A3).
 *
 * Fetches the document Claude publishes at its client_id URL, compares it with the pinned copy in
 * packages/shared/src/constants/mcp-oauth.ts and, when they differ, opens an insight in Maskin so
 * a person decides whether to update the pin. It never changes what the server does at runtime
 * (the server has no live fetch) and it always exits 0: a scheduled check must not fail a deploy,
 * and a fetch that fails (Claude's CDN can answer a datacenter with 403) is a warning, not a
 * finding.
 *
 * Optional env, to open the insight (without them the difference is only printed):
 *   MASKIN_API_URL       origin of the Maskin API, for example https://maskin.io
 *   MASKIN_API_KEY       API key of an actor allowed to create insights
 *   MASKIN_WORKSPACE_ID  workspace the insight goes in
 */
import { diffClientRecord } from '../../apps/dev/src/lib/oauth-server/client-drift'
import { MCP_OAUTH_PINNED_CLAUDE_CLIENT } from '../../packages/shared/src/constants/mcp-oauth'

const TITLE = "[Gap] Claude's published client record no longer matches our pinned copy"

function insightBody(url: string, differences: string[]): string {
	return [
		`The scheduled drift check compared the pinned Claude client record with ${url} and found ${differences.length} difference(s):`,
		'',
		...differences.map((d) => `- ${d}`),
		'',
		'Nothing changed at runtime: sign-in keeps using the pinned copy. Someone needs to decide whether to update the pin in packages/shared/src/constants/mcp-oauth.ts. A removed redirect address stops working for Claude only after the pin is updated; a new one is not accepted until it is.',
	].join('\n')
}

async function openInsight(url: string, differences: string[]): Promise<void> {
	const apiUrl = process.env.MASKIN_API_URL?.trim().replace(/\/$/, '')
	const apiKey = process.env.MASKIN_API_KEY?.trim()
	const workspaceId = process.env.MASKIN_WORKSPACE_ID?.trim()
	if (!apiUrl || !apiKey || !workspaceId) {
		console.log(
			'::warning::Claude client record drift found, but MASKIN_API_URL, MASKIN_API_KEY or MASKIN_WORKSPACE_ID is not set, so no insight was opened.',
		)
		return
	}
	const res = await fetch(`${apiUrl}/api/objects`, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${apiKey}`,
			'X-Workspace-Id': workspaceId,
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({
			type: 'insight',
			status: 'new',
			title: TITLE,
			content: insightBody(url, differences),
			metadata: { source: 'other' },
		}),
		signal: AbortSignal.timeout(15_000),
	})
	if (!res.ok) {
		console.log(`::warning::Could not open the insight: HTTP ${res.status}`)
		return
	}
	console.log('Opened an insight for the drift.')
}

async function main(): Promise<void> {
	const url = MCP_OAUTH_PINNED_CLAUDE_CLIENT.client_id
	const res = await fetch(url, {
		headers: { Accept: 'application/json' },
		redirect: 'error',
		signal: AbortSignal.timeout(10_000),
	})
	if (!res.ok) {
		console.log(`::warning::Could not fetch ${url}: HTTP ${res.status}. No comparison made.`)
		return
	}
	const live: unknown = await res.json()
	const differences = diffClientRecord(MCP_OAUTH_PINNED_CLAUDE_CLIENT, live)
	if (differences.length === 0) {
		console.log('The pinned Claude client record matches the live document.')
		return
	}
	console.log(`Drift found:\n${differences.map((d) => `- ${d}`).join('\n')}`)
	await openInsight(url, differences)
}

main().catch((err) => {
	// Never fail: this is a scheduled signal, not a gate.
	console.log(`::warning::Claude client drift check did not complete: ${String(err)}`)
})
