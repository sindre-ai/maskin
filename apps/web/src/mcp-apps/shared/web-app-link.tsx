import { type WebAppTarget, buildWebAppPath } from '@maskin/shared'
import { ExternalLink } from 'lucide-react'
import { useWebAppContext } from './mcp-app-provider'

// Re-export the contract so existing consumers keep importing from the
// `mcp-apps/shared` barrel. The single source of truth lives in
// `@maskin/shared/web-app-urls` so the MCP server and the web cards build
// hrefs from the same table.
export { buildWebAppPath } from '@maskin/shared'
export type {
	WebAppObjectType,
	WebAppSettingsSection,
	WebAppTarget,
} from '@maskin/shared'

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
