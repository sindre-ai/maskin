import { stripTrailingSlash } from '@maskin/shared'

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

export function fileViewerUrl(frontendUrl: string, workspaceId: string, fileId: string): string {
	return `${stripTrailingSlash(frontendUrl)}/${workspaceId}/files/${fileId}`
}

export function fileStorageKey(workspaceId: string, fileId: string): string {
	return `workspaces/${workspaceId}/files/${fileId}`
}

export function actorAvatarStorageKey(
	workspaceId: string,
	actorId: string,
	ext: 'png' | 'jpg',
): string {
	return `workspaces/${workspaceId}/avatars/${actorId}.${ext}`
}

// The upload endpoint stores the raw bytes in a private S3 bucket, and the
// GET /api/actors/:id/avatar proxy serves them publicly. `ws` pins the S3
// prefix (avatars are workspace-scoped) so the proxy can resolve the object
// without guessing a workspace for actors that live in more than one.
// `v` is appended so re-uploads bust the browser/CDN cache on the same actor id.
export function actorAvatarUrl(workspaceId: string, actorId: string, versionMs: number): string {
	return `${frontendBaseUrl()}/api/actors/${actorId}/avatar?ws=${workspaceId}&v=${versionMs}`
}
