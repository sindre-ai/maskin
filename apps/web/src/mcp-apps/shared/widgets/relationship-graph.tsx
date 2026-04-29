import { StatusBadge } from '@/components/shared/status-badge'
import { TypeBadge } from '@/components/shared/type-badge'
import { Card } from '@/components/ui/card'
import { cn } from '@/lib/cn'
import { useWebAppHref } from '../web-app-link'
import type { RelationshipGraphProps } from './types'

/**
 * Read-only nodes-and-edges view for `create_graph` / `list_relationships`
 * responses. Today this is a list-of-lists rendering — F7 will swap in a
 * canvas-based layout while preserving the same prop contract.
 *
 * The schema's `relationship_types` is reflected back in the edge label so
 * custom relationship vocabularies render correctly. When the schema is
 * absent, we fall back to the raw edge type from the payload.
 */
export function RelationshipGraph({
	nodes,
	edges,
	schema,
	className,
}: RelationshipGraphProps) {
	const knownTypes = new Set(schema?.relationship_types ?? [])

	return (
		<div className={cn('space-y-4', className)}>
			<section>
				<h3 className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
					Nodes ({nodes.length})
				</h3>
				<div className="space-y-1">
					{nodes.map((node) => (
						<Card key={node.id} className="flex items-center gap-3 px-3 py-2">
							<TypeBadge type={node.type} />
							<span className="flex-1 truncate text-sm text-foreground">
								{node.title || 'Untitled'}
							</span>
							<StatusBadge status={node.status} />
						</Card>
					))}
				</div>
			</section>
			{edges.length > 0 && (
				<section>
					<h3 className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
						Edges ({edges.length})
					</h3>
					<div className="space-y-1">
						{edges.map((edge) => {
							const known = knownTypes.size === 0 || knownTypes.has(edge.type)
							return (
								<Card
									key={edge.id}
									className="flex items-center gap-2 px-3 py-2 text-sm"
								>
									<NodeIdLink id={edge.source} />
									<span
										className={cn(
											'text-xs font-medium',
											known ? 'text-accent-foreground' : 'text-muted-foreground italic',
										)}
									>
										{edge.type.replace(/_/g, ' ')}
									</span>
									<span className="text-muted-foreground">→</span>
									<NodeIdLink id={edge.target} />
								</Card>
							)
						})}
					</div>
				</section>
			)}
		</div>
	)
}

function NodeIdLink({ id }: { id: string }) {
	const href = useWebAppHref({ kind: 'object', id })
	const short = id.slice(0, 8)
	if (!href) {
		return (
			<span className="font-mono text-xs text-muted-foreground truncate max-w-24">{short}</span>
		)
	}
	return (
		<a
			href={href}
			target="_blank"
			rel="noreferrer"
			className="font-mono text-xs text-muted-foreground underline-offset-2 hover:text-accent hover:underline truncate max-w-24"
			title={id}
		>
			{short}
		</a>
	)
}
