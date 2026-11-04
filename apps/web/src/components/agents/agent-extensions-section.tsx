import { AgentSectionHeading } from '@/components/agents/agent-section-heading'
import { EmptyState } from '@/components/shared/empty-state'
import { useExtensions } from '@/hooks/use-extensions'
import type { ActorResponse } from '@/lib/api'
import { allowedToolNames, declaredTools } from '@/lib/extension-grants'
import { useWorkspace } from '@/lib/workspace-context'
import { Link } from '@tanstack/react-router'
import { ChevronRight } from 'lucide-react'

/**
 * Read-only mirror of the Agent access grants: the custom extensions this agent
 * can call. The extension page owns the grants, so each row links back to it.
 */
export function AgentExtensionsSection({ agent }: { agent: ActorResponse }) {
	const { workspaceId } = useWorkspace()
	const { data: extensions } = useExtensions(workspaceId)

	const callable = (extensions ?? [])
		.map((ext) => ({
			ext,
			allowed: allowedToolNames(ext, agent.id).length,
			total: declaredTools(ext).length,
		}))
		.filter((row) => row.allowed > 0)

	return (
		<section aria-labelledby="agent-extensions-heading" className="flex flex-col gap-2.5">
			<AgentSectionHeading
				id="agent-extensions-heading"
				title={`Extensions ${agent.name} can call`}
				note={callable.length > 0 ? String(callable.length) : undefined}
			/>
			<p className="text-[11px] text-muted-foreground">
				Read-only. Grants are managed on each extension's page.
			</p>
			{callable.length === 0 ? (
				<EmptyState compact title="No extension grants yet" className="py-6" />
			) : (
				<ul className="flex flex-col gap-2">
					{callable.map(({ ext, allowed, total }) => (
						<li key={ext.id}>
							<Link
								to="/$workspaceId/settings/extensions/$extId"
								params={{ workspaceId, extId: ext.id }}
								className="flex items-center justify-between gap-3 rounded-xl border border-border bg-card p-3 hover:bg-muted"
							>
								<div className="min-w-0">
									<div className="truncate text-[13px] font-semibold">{ext.name}</div>
									<div className="text-[11px] text-muted-foreground">
										{allowed} of {total} tools
									</div>
								</div>
								<span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
									Open extension
									<ChevronRight size={14} aria-hidden />
								</span>
							</Link>
						</li>
					))}
				</ul>
			)}
		</section>
	)
}
