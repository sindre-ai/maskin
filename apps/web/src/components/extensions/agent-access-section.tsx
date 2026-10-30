import { GrantAgentDialog } from '@/components/extensions/grant-agent-dialog'
import { ActorAvatar } from '@/components/shared/actor-avatar'
import { ListSkeleton } from '@/components/shared/loading-skeleton'
import { RelativeTime } from '@/components/shared/relative-time'
import { ViewerTooltip } from '@/components/shared/viewer-tooltip'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { useActors } from '@/hooks/use-actors'
import { useCanWrite } from '@/hooks/use-can-write'
import {
	useExtensionAttempted,
	useRevokeAgentGrant,
	useSetAgentGrant,
} from '@/hooks/use-extensions'
import type { ActorListItem, ExtensionResponse, ExtensionToolEffect } from '@/lib/api'
import { cn } from '@/lib/cn'
import {
	allowedToolNames,
	blockedAttempts,
	declaredTools,
	initialSelection,
} from '@/lib/extension-grants'
import { useState } from 'react'
import { toast } from 'sonner'

/**
 * Agent access: default-deny, per tool. Every agent in the workspace is listed
 * with a toggle that starts off. Everything shown comes from the extension row
 * (declared tools, stored grants) or the refused-call log. The design spec's
 * "granted by Sebastian, 2m ago" line has no stored source, so it is not shown.
 */
export function AgentAccessSection({
	ext,
	workspaceId,
}: { ext: ExtensionResponse; workspaceId: string }) {
	const canWrite = useCanWrite()
	const { data: actors, isLoading } = useActors(workspaceId)
	const { data: attempted } = useExtensionAttempted(workspaceId, ext.id)
	const setGrant = useSetAgentGrant(workspaceId, ext.id)
	const revoke = useRevokeAgentGrant(workspaceId, ext.id)
	const [grantFor, setGrantFor] = useState<ActorListItem | null>(null)

	const tools = declaredTools(ext)
	const agents = (actors ?? []).filter((a) => a.type === 'agent')

	const submitGrant = async (agent: ActorListItem, selection: Record<string, boolean>) => {
		if (!canWrite) return
		const effects: Record<string, ExtensionToolEffect> = {}
		for (const t of tools) effects[t.name] = selection[t.name] ? 'allow' : 'deny'
		try {
			await setGrant.mutateAsync({ agentId: agent.id, tools: effects })
			setGrantFor(null)
			toast.success(`${agent.name} can now call ${ext.name}`)
		} catch (err) {
			toast.error(err instanceof Error ? err.message : 'Could not save the grant')
		}
	}

	const removeAccess = async (agent: ActorListItem) => {
		if (!canWrite) return
		try {
			await revoke.mutateAsync(agent.id)
		} catch (err) {
			toast.error(err instanceof Error ? err.message : 'Could not remove access')
		}
	}

	return (
		<section
			className="rounded-xl border border-border bg-card p-4"
			aria-labelledby="agent-access-heading"
		>
			<div className="flex flex-wrap items-start justify-between gap-3">
				<div className="min-w-0">
					<div className="flex items-center gap-2">
						<h2 id="agent-access-heading" className="text-[13px] font-bold">
							Agent access
						</h2>
						<Badge variant="outline">Default deny</Badge>
					</div>
					<p className="mt-1 text-xs text-muted-foreground">
						Only these agents can call {ext.name} MCP tools. Everyone else is blocked at the tool
						boundary.
					</p>
				</div>
			</div>

			<div className="mt-4 border-t border-border pt-4">
				{tools.length === 0 ? (
					<p className="text-xs text-muted-foreground">
						This extension has no MCP tools yet. Once it declares some, you can grant agents access
						to them here.
					</p>
				) : isLoading ? (
					<ListSkeleton rows={3} />
				) : agents.length === 0 ? (
					<p className="text-xs text-muted-foreground">
						There are no agents in this workspace yet.
					</p>
				) : (
					<ul className="grid grid-cols-1 gap-2">
						{agents.map((agent) => {
							const allowed = allowedToolNames(ext, agent.id)
							const tried = blockedAttempts(ext, agent.id, attempted)
							const on = allowed.length > 0
							return (
								<li key={agent.id} className="min-w-0 rounded-xl border border-border bg-card p-3">
									<div className="flex flex-wrap items-center justify-between gap-3">
										<div className="flex min-w-0 flex-1 basis-40 items-center gap-3">
											<ActorAvatar name={agent.name} type={agent.type} id={agent.id} size="md" />
											<div className="min-w-0">
												<div className="truncate text-[13px] font-semibold">{agent.name}</div>
												<div
													className={cn(
														'text-[11px]',
														tried && !on ? 'text-warning' : 'text-muted-foreground',
													)}
												>
													{on ? (
														`Granted ${allowed.length} of ${tools.length} tools`
													) : tried ? (
														<>
															Tried to call <span className="font-mono">{tried.tools[0]}</span>{' '}
															<RelativeTime date={tried.lastAttemptedAt} /> · blocked
														</>
													) : (
														'No access · default deny'
													)}
												</div>
											</div>
										</div>
										<div className="flex flex-wrap items-center gap-3">
											{on && (
												<Badge variant="outline" className="border-success/40 text-success">
													Allowed
												</Badge>
											)}
											{!on && !tried && (
												<Badge variant="outline" className="text-muted-foreground">
													Blocked
												</Badge>
											)}
											{tried && (
												<Badge variant="outline" className="border-warning/40 text-warning">
													Attempted
												</Badge>
											)}
											{tried && !on && (
												<ViewerTooltip>
													<Button size="sm" disabled={!canWrite} onClick={() => setGrantFor(agent)}>
														Grant
													</Button>
												</ViewerTooltip>
											)}
											{on && (
												<ViewerTooltip>
													<Button
														variant="ghost"
														size="sm"
														disabled={!canWrite}
														onClick={() => setGrantFor(agent)}
													>
														Edit tools
													</Button>
												</ViewerTooltip>
											)}
											<ViewerTooltip>
												<Switch
													checked={on}
													disabled={revoke.isPending || !canWrite}
													aria-label={`${agent.name} can call ${ext.name} tools`}
													onCheckedChange={(next) =>
														next ? setGrantFor(agent) : removeAccess(agent)
													}
												/>
											</ViewerTooltip>
										</div>
									</div>
									{on && (
										<div className="mt-2 flex flex-wrap gap-1 pl-0 sm:pl-11">
											{tools.map((t) => (
												<span
													key={t.name}
													className={cn(
														'rounded-md border px-1.5 py-0.5 font-mono text-[11px]',
														allowed.includes(t.name)
															? 'border-border bg-muted'
															: 'border-transparent text-muted-foreground line-through opacity-60',
													)}
												>
													{t.name}
												</span>
											))}
										</div>
									)}
								</li>
							)
						})}
					</ul>
				)}
			</div>

			{grantFor && (
				<GrantAgentDialog
					key={grantFor.id}
					open
					onOpenChange={(open) => !open && setGrantFor(null)}
					agentName={grantFor.name}
					extensionName={ext.name}
					tools={tools}
					initial={initialSelection(ext, grantFor.id)}
					pending={setGrant.isPending}
					onSubmit={(selection) => submitGrant(grantFor, selection)}
				/>
			)}
		</section>
	)
}
