// The file URL is the whole point of attached files: agents paste it into
// Slack, emails, comments. Shipping a `http://localhost:5173/...` link from
// prod would silently break every share, so require `FRONTEND_URL` outside of
// dev and fail loud instead of returning a broken URL.
const DEV_FRONTEND_FALLBACK = 'http://localhost:5173'

function isProduction(): boolean {
	return process.env.NODE_ENV === 'production'
}

export function frontendBaseUrl(): string {
	const url = process.env.FRONTEND_URL
	if (url) return stripTrailingSlash(url)
	if (isProduction()) {
		throw new Error('FRONTEND_URL must be set in production to mint shareable file URLs')
	}
	return DEV_FRONTEND_FALLBACK
}

function stripTrailingSlash(s: string): string {
	return s.endsWith('/') ? s.slice(0, -1) : s
}

export function fileViewerUrl(frontendUrl: string, workspaceId: string, fileId: string): string {
	return `${stripTrailingSlash(frontendUrl)}/${workspaceId}/files/${fileId}`
}

export function fileStorageKey(workspaceId: string, fileId: string): string {
	return `workspaces/${workspaceId}/files/${fileId}`
}

// Canonical URL agents should emit when referencing an object in a comment,
// notification, or description. Agents otherwise hallucinate the host (the
// `app.maskin.ai` bug) — route every agent-facing object link through this
// helper so the host + workspace segment stay in lockstep with the web app.
export function agentObjectUrl(frontendUrl: string, workspaceId: string, objectId: string): string {
	return `${stripTrailingSlash(frontendUrl)}/${workspaceId}/objects/${objectId}`
}
