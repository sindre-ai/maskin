import { IntegrationsManager } from '@/components/integrations/integrations-manager'
import { RouteError } from '@/components/shared/route-error'
import { Separator } from '@/components/ui/separator'
import { useWorkspace } from '@/lib/workspace-context'
import { Link, createFileRoute } from '@tanstack/react-router'
import { ChevronRight } from 'lucide-react'

export const Route = createFileRoute('/_authed/$workspaceId/settings/integrations')({
	component: IntegrationsPage,
	errorComponent: ({ error }) => <RouteError error={error} />,
})

/**
 * Credential surfaces that are integrations in substance but not in the
 * provider registry: `keys` is what agents *run on*, `mcp` is how an external
 * agent connects *into* Maskin. Both keep their own deep-linkable routes (the
 * onboarding flow and session detail panel link straight to them) and are
 * reached from here rather than from a seventh rail tab.
 */
const CREDENTIAL_LINKS = [
	{
		to: '/$workspaceId/settings/keys' as const,
		title: 'Model providers',
		detail: 'Claude subscription, API keys and custom endpoints agents run on',
	},
	{
		to: '/$workspaceId/settings/mcp' as const,
		title: 'Connect your coding agent',
		detail: 'MCP server command and workspace API key',
	},
]

function IntegrationsPage() {
	const { workspaceId } = useWorkspace()

	return (
		<div className="max-w-[580px]">
			<p className="mb-3 text-xs leading-relaxed text-muted-foreground">
				Connect the tools your agents read from and write to. Each connection is scoped to this
				workspace.
			</p>
			<IntegrationsManager />

			<Separator className="my-6" />

			<div className="space-y-2">
				{CREDENTIAL_LINKS.map((link) => (
					<Link
						key={link.to}
						to={link.to}
						params={{ workspaceId }}
						className="flex items-center gap-3 rounded-xl border border-border bg-card p-3 transition-colors hover:bg-muted"
					>
						<span className="min-w-0 flex-1">
							<span className="block truncate text-sm font-medium text-foreground">
								{link.title}
							</span>
							<span className="block truncate text-xs text-muted-foreground">{link.detail}</span>
						</span>
						<ChevronRight size={16} className="shrink-0 text-muted-foreground" />
					</Link>
				))}
			</div>
		</div>
	)
}
