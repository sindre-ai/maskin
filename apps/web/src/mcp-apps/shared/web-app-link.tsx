import { ExternalLink } from 'lucide-react'
import { useWebAppContext } from './mcp-app-provider'

/**
 * Object types we know how to deep-link from MCP cards. Keep aligned with the
 * web app's route tree under `apps/web/src/routes/_authed/$workspaceId/`.
 */
export type WebAppTarget =
	| { kind: 'workspace' }
	| { kind: 'object'; id: string }
	| { kind: 'trigger'; id?: string }
	| { kind: 'agent'; id?: string }
	| { kind: 'activity' }
	| {
			kind: 'settings'
			section?: 'integrations' | 'keys' | 'mcp' | 'members' | 'skills' | 'objects'
	  }
	| { kind: 'pulse' }

export function buildWebAppPath(workspaceId: string, target: WebAppTarget): string {
	const root = `/${workspaceId}`
	switch (target.kind) {
		case 'workspace':
		case 'pulse':
			return root
		case 'object':
			return `${root}/objects/${target.id}`
		case 'trigger':
			return target.id ? `${root}/triggers/${target.id}` : `${root}/triggers`
		case 'agent':
			return target.id ? `${root}/agents/${target.id}` : `${root}/agents`
		case 'activity':
			return `${root}/activity`
		case 'settings':
			return target.section ? `${root}/settings/${target.section}` : `${root}/settings`
	}
}

/**
 * Build a deep link URL into the Maskin web app for the given target. Returns
 * `null` if the MCP card does not have a web-app context (older server, env
 * var not set, etc.) — callers should hide their link affordance when that
 * happens.
 */
export function useWebAppHref(target: WebAppTarget): string | null {
	const ctx = useWebAppContext()
	if (!ctx) return null
	return `${ctx.baseUrl}${buildWebAppPath(ctx.workspaceId, target)}`
}

/**
 * Tiny anchor that links to the web app for the given target. Renders nothing
 * when no web-app context is available, so callers can drop it in card headers
 * without conditional logic. Opens in a new tab — the chat surface is the
 * primary view, the web app is a secondary surface for context.
 */
export function WebAppLink({
	target,
	className,
	label,
}: {
	target: WebAppTarget
	className?: string
	label?: string
}) {
	const href = useWebAppHref(target)
	if (!href) return null
	return (
		<a
			href={href}
			target="_blank"
			rel="noreferrer"
			className={
				className ??
				'inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors'
			}
		>
			<ExternalLink className="size-3" />
			{label ?? 'Open in Maskin'}
		</a>
	)
}
