import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import { API_URL, MAIN_WORKSPACE_ID, requireEnv } from './config'

/**
 * Uploads a PNG to the main workspace's files, named demo-shot-<shot>-<date>.png.
 * One file per shot per day: a second run on the same day replaces that day's file, a run on
 * another day adds a new one, so older shots stay available. Uses the running agent's own
 * key (MASKIN_API_KEY); this is the only write outside the demo workspace.
 */
export async function uploadShot(path: string): Promise<string> {
	const apiKey = requireEnv('MASKIN_API_KEY')
	const name = basename(path)
	const headers = {
		'Content-Type': 'application/json',
		Authorization: `Bearer ${apiKey}`,
		'X-Workspace-Id': MAIN_WORKSPACE_ID,
	}
	const content = (await readFile(path)).toString('base64')

	const listRes = await fetch(`${API_URL}/files?q=${encodeURIComponent(name)}`, { headers })
	if (!listRes.ok) throw new Error(`Listing files failed: ${listRes.status}`)
	const sameName = ((await listRes.json()) as { id: string; name: string }[]).find(
		(f) => f.name === name,
	)

	const res = sameName
		? await fetch(`${API_URL}/files/${sameName.id}`, {
				method: 'PATCH',
				headers,
				body: JSON.stringify({ content, encoding: 'base64', mime_type: 'image/png' }),
			})
		: await fetch(`${API_URL}/files`, {
				method: 'POST',
				headers,
				body: JSON.stringify({
					name,
					description: 'Product screenshot from the Maskin Demo workspace. Demo data only.',
					mime_type: 'image/png',
					encoding: 'base64',
					content,
				}),
			})
	if (!res.ok) throw new Error(`Uploading ${name} failed: ${res.status} ${await res.text()}`)
	return ((await res.json()) as { id: string }).id
}
