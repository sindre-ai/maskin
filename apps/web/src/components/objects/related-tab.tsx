import { AgentWorkingBadge } from '@/components/shared/agent-working-badge'
import { RelativeTime } from '@/components/shared/relative-time'
import { TypeBadge } from '@/components/shared/type-badge'
import { useObjectFileAttachments } from '@/hooks/use-object-file-attachments'
import { useObjectGraph, useObjects } from '@/hooks/use-objects'
import { useCreateRelationship, useDeleteRelationship } from '@/hooks/use-relationships'
import type { ObjectResponse, RelationshipResponse } from '@/lib/api'
import { cn } from '@/lib/cn'
import { getStatusColor, getTypeColor, statusLabel } from '@/lib/constants'
import { useWorkspace } from '@/lib/workspace-context'
import { Link } from '@tanstack/react-router'
import { X } from 'lucide-react'
import { useMemo, useRef, useState } from 'react'
import { AddLinkForm } from './linked-objects'
import { resolveRelatedRows } from './related-tab-utils'

const DEFAULT_RELATIONSHIP_TYPES = ['informs', 'breaks_into', 'blocks', 'relates_to', 'duplicates']

/**
 * Related tab for the object detail page (mockup 1155–1174): one bordered list
 * per edge type under a mono group label, each row reading
 * `dot · TYPE · name · status · when · ×`, then the two dashed add affordances.
 * There is no table header and no sort — the tab is a reading of the object's
 * graph, and the Objects list is where sorting lives.
 */
export function RelatedTab({ object }: { object: ObjectResponse }) {
	const { workspaceId, workspace } = useWorkspace()
	const { data: graph } = useObjectGraph(workspaceId, object.id)
	const { data: allObjects } = useObjects(workspaceId)
	const createRelationship = useCreateRelationship(workspaceId, object.id)
	const deleteRelationship = useDeleteRelationship(workspaceId, object.id)
	const [showAdd, setShowAdd] = useState(false)
	const fileInputRef = useRef<HTMLInputElement>(null)
	const { upload, isUploading } = useObjectFileAttachments({
		workspaceId,
		objectId: object.id,
		objectType: object.type,
	})

	const settings = workspace.settings as Record<string, unknown>
	const relationshipTypes =
		(settings?.relationship_types as string[] | undefined) ?? DEFAULT_RELATIONSHIP_TYPES

	// Same resolver the tab-trigger count uses, so the rows in this tab and the
	// "Related (N)" count in the segmented control stay in lockstep.
	const resolved = useMemo(
		() => resolveRelatedRows(graph, allObjects, object.id),
		[graph, allObjects, object.id],
	)
	const existingRelationships: RelationshipResponse[] = graph?.relationships ?? []

	// Grouped by relationship type, in first-occurrence order.
	const groups = useMemo(() => {
		const byType = new Map<string, typeof resolved>()
		for (const row of resolved) {
			const existing = byType.get(row.rel.type)
			if (existing) existing.push(row)
			else byType.set(row.rel.type, [row])
		}
		return [...byType.entries()].map(([type, rows]) => ({ type, rows }))
	}, [resolved])

	return (
		<div className="flex w-full min-w-0 flex-col gap-4 pt-3">
			{groups.map((group) => (
				<div key={group.type}>
					<div className="mb-[7px] flex items-baseline gap-[7px]">
						<span className="font-mono text-[9.5px] font-bold uppercase tracking-[0.09em] text-muted-foreground">
							{group.type.replace(/_/g, ' ')}
						</span>
						<span className="text-[10.5px] font-semibold tabular-nums text-border-strong">
							{group.rows.length}
						</span>
					</div>
					<div className="overflow-hidden rounded-xl border border-border">
						{group.rows.map((row, index) => (
							<div
								key={row.rel.id}
								className={cn(
									'relative flex items-center gap-2.5 px-3 py-2.5 transition-colors hover:bg-muted/40',
									index > 0 && 'border-t border-border',
								)}
							>
								<span
									aria-hidden="true"
									className={cn(
										'size-[7px] shrink-0 rounded-[2px]',
										getTypeColor(row.object.type).bg,
									)}
								/>
								<TypeBadge
									type={row.object.type}
									variant="mono"
									className="shrink-0 text-[8.5px]"
								/>
								<span className="min-w-0 flex-1 truncate text-[12.5px] font-semibold text-foreground">
									{row.object.title ?? 'Untitled'}
								</span>
								{/* A linked object an agent is working on right now says so here —
								    the row's status slot is where that live state belongs. */}
								{row.object.activeSessionId ? (
									<span className="relative z-[2] shrink-0">
										<AgentWorkingBadge
											sessionId={row.object.activeSessionId}
											workspaceId={workspaceId}
										/>
									</span>
								) : (
									<span
										className={cn(
											'hidden max-w-[150px] shrink-0 truncate text-[11px] font-semibold md:block',
											getStatusColor(row.object.status).text,
										)}
									>
										{statusLabel(row.object.status)}
									</span>
								)}
								<RelativeTime
									date={row.object.updatedAt ?? row.object.createdAt}
									className="w-[38px] shrink-0 text-right text-[10px] tabular-nums text-border-strong"
								/>
								{/* The link covers the row so the whole thing opens the object;
								    the remove button sits above it so × still hits ×. */}
								<Link
									to="/$workspaceId/objects/$objectId"
									params={{ workspaceId, objectId: row.object.id }}
									aria-label={row.object.title ?? 'Untitled'}
									className="absolute inset-0 z-[1]"
								/>
								<button
									type="button"
									aria-label={`Remove link to ${row.object.title ?? 'Untitled'}`}
									title="Remove link"
									onClick={() => deleteRelationship.mutate(row.rel.id)}
									className="relative z-[2] shrink-0 px-0.5 text-border transition-colors hover:text-destructive"
								>
									<X size={13} />
								</button>
							</div>
						))}
					</div>
				</div>
			))}

			{showAdd && (
				<AddLinkForm
					objectId={object.id}
					objectType={object.type}
					allObjects={allObjects ?? []}
					relationshipTypes={relationshipTypes}
					existingRelationships={existingRelationships}
					onCreateRelationship={(data) => createRelationship.mutate(data)}
					onClose={() => setShowAdd(false)}
				/>
			)}

			<div className="flex flex-wrap gap-2">
				<button
					type="button"
					onClick={() => setShowAdd((v) => !v)}
					className="inline-flex h-7 items-center rounded-full border border-dashed border-border-strong px-3 text-[11.5px] font-semibold text-muted-foreground transition-colors hover:border-ring hover:text-foreground"
				>
					+ Link an object
				</button>
				<button
					type="button"
					onClick={() => fileInputRef.current?.click()}
					disabled={isUploading}
					className="inline-flex h-7 items-center rounded-full border border-dashed border-border-strong px-3 text-[11.5px] font-semibold text-muted-foreground transition-colors hover:border-ring hover:text-foreground disabled:opacity-50"
				>
					{isUploading ? 'Uploading…' : '+ Upload a file'}
				</button>
				<input
					ref={fileInputRef}
					type="file"
					multiple
					className="hidden"
					onChange={(e) => {
						const picked = e.target.files
						if (picked?.length) void upload(Array.from(picked))
						e.target.value = ''
					}}
				/>
			</div>

			{resolved.length === 0 && (
				<div className="px-3 py-6 text-center text-[12.5px] text-muted-foreground">
					No related objects yet.
				</div>
			)}
		</div>
	)
}
