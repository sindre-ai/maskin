import { AddExtensionDialog } from '@/components/extensions/add-extension-dialog'
import { mcpReady, mcpToolCount } from '@/components/extensions/mcp-form'
import { ListSkeleton } from '@/components/shared/loading-skeleton'
import { ViewerTooltip } from '@/components/shared/viewer-tooltip'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { useCanWrite } from '@/hooks/use-can-write'
import { useExtensions } from '@/hooks/use-extensions'
import type { ExtensionResponse } from '@/lib/api'
import { useWorkspace } from '@/lib/workspace-context'
import { Link, useNavigate } from '@tanstack/react-router'
import { ChevronRight, Plus } from 'lucide-react'
import { useState } from 'react'

/**
 * One status chip per row: Live beats Listening beats Not configured. An
 * extension with only an MCP reads On, N tools once its MCP is attached.
 */
export function extensionRowStatus(ext: ExtensionResponse): {
	label: string
	variant: 'live' | 'outline'
} {
	if (!ext.webhookConfig && ext.mcpConfig && ext.status === 'active' && mcpReady(ext)) {
		return { label: `On, ${mcpToolCount(ext)} tools`, variant: 'live' }
	}
	if (ext.lastDeliveryAt) return { label: 'Live', variant: 'live' }
	if (ext.webhookConfig && ext.status === 'active') return { label: 'Listening', variant: 'live' }
	return { label: 'Not configured', variant: 'outline' }
}

function extensionKinds(ext: ExtensionResponse): string {
	const kinds = [ext.mcpConfig && 'MCP', ext.webhookConfig && 'Webhook'].filter(Boolean)
	return kinds.length > 0 ? kinds.join(' + ') : 'Webhook'
}

/**
 * Custom (bring-your-own) extensions read from the extensions table.
 * Live means at least one committed delivery in the last 14 days.
 */
export function CustomExtensionsSection() {
	const { workspaceId } = useWorkspace()
	const canWrite = useCanWrite()
	const navigate = useNavigate()
	const { data: extensions, isLoading, isError } = useExtensions(workspaceId)
	const [adding, setAdding] = useState(false)

	return (
		<section className="mt-8 space-y-3" aria-labelledby="custom-extensions-heading">
			<div className="flex items-start justify-between gap-4">
				<div className="min-w-0">
					<h2 id="custom-extensions-heading" className="text-[13px] font-bold">
						Custom
					</h2>
					<p className="text-xs leading-relaxed text-muted-foreground">
						Custom MCPs and webhooks a workspace can wire up without a code change.
					</p>
				</div>
				<ViewerTooltip>
					<Button
						size="sm"
						onClick={() => setAdding(true)}
						disabled={!canWrite}
						className="shrink-0"
					>
						<Plus size={14} />
						Add extension
					</Button>
				</ViewerTooltip>
			</div>

			{isLoading ? (
				<ListSkeleton rows={2} />
			) : isError ? (
				<p className="text-xs text-error">Could not load your custom extensions.</p>
			) : (
				<ul className="space-y-2">
					{(extensions ?? []).map((ext) => {
						const status = extensionRowStatus(ext)
						return (
							<li key={ext.id}>
								<Link
									to="/$workspaceId/settings/extensions/$extId"
									params={{ workspaceId, extId: ext.id }}
									className="flex items-center justify-between gap-4 rounded-xl border border-border bg-card p-3 transition-colors hover:border-border-strong hover:shadow-sm"
								>
									<div className="min-w-0">
										<span className="block truncate text-[13px] font-semibold">{ext.name}</span>
										<span className="block truncate text-xs text-muted-foreground">
											{extensionKinds(ext)}
										</span>
									</div>
									<div className="flex shrink-0 items-center gap-2">
										<Badge variant={status.variant}>{status.label}</Badge>
										<ChevronRight size={14} className="text-muted-foreground" aria-hidden />
									</div>
								</Link>
							</li>
						)
					})}
					<li>
						<ViewerTooltip className="flex w-full">
							<button
								type="button"
								onClick={() => setAdding(true)}
								disabled={!canWrite}
								className="flex w-full items-center justify-between gap-4 rounded-xl border border-dashed border-border bg-card p-3 text-left transition-colors hover:border-border-strong disabled:cursor-not-allowed disabled:opacity-50"
							>
								<div className="min-w-0">
									<span className="block truncate text-[13px] font-semibold">Add an extension</span>
									<span className="block truncate text-xs text-muted-foreground">
										Paste an MCP URL, wire a webhook, or both.
									</span>
								</div>
								<Plus size={14} className="shrink-0 text-muted-foreground" aria-hidden />
							</button>
						</ViewerTooltip>
					</li>
				</ul>
			)}

			<AddExtensionDialog
				workspaceId={workspaceId}
				existingNames={(extensions ?? []).map((e) => e.name)}
				open={adding}
				onOpenChange={setAdding}
				onCreated={(ext) => {
					setAdding(false)
					navigate({
						to: '/$workspaceId/settings/extensions/$extId',
						params: { workspaceId, extId: ext.id },
					})
				}}
			/>
		</section>
	)
}
