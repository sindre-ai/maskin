import { EmptyState } from '@/components/shared/empty-state'
import { RelativeTime } from '@/components/shared/relative-time'
import { StatusBadge } from '@/components/shared/status-badge'
import { TypeBadge } from '@/components/shared/type-badge'
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from '@/components/ui/table'
import { cn } from '@/lib/cn'
import { WebAppLink } from '../web-app-link'
import type { ObjectListTableProps } from './types'

/**
 * Scannable list/table view for many objects. Reuses shadcn `Table` so
 * formatting stays consistent with the web app's data table. Column set is
 * intentionally minimal here — F7 will extend with schema-driven columns
 * (custom metadata fields surfaced through `WorkspaceSchemaField.values`).
 */
export function ObjectListTable({
	objects,
	schema,
	emptyTitle,
	emptyDescription,
	className,
}: ObjectListTableProps) {
	if (!objects.length) {
		return (
			<EmptyState
				title={emptyTitle ?? 'No objects'}
				description={emptyDescription ?? 'No objects match the current filters.'}
			/>
		)
	}

	const labelFor = (type: string) => schema?.types?.[type]?.display_name ?? type

	return (
		<div className={cn('w-full', className)}>
			<Table>
				<TableHeader>
					<TableRow>
						<TableHead className="w-24">Type</TableHead>
						<TableHead>Title</TableHead>
						<TableHead className="w-32">Status</TableHead>
						<TableHead className="w-24">Updated</TableHead>
						<TableHead className="w-16 text-right">Open</TableHead>
					</TableRow>
				</TableHeader>
				<TableBody>
					{objects.map((obj) => (
						<TableRow key={obj.id}>
							<TableCell>
								<TypeBadge type={labelFor(obj.type)} />
							</TableCell>
							<TableCell className="font-medium text-foreground">
								{obj.title || 'Untitled'}
							</TableCell>
							<TableCell>
								<StatusBadge status={obj.status} />
							</TableCell>
							<TableCell className="text-xs text-muted-foreground">
								{obj.updatedAt ? <RelativeTime date={obj.updatedAt} /> : '—'}
							</TableCell>
							<TableCell className="text-right">
								<WebAppLink target={{ kind: 'object', id: obj.id }} label="Open" />
							</TableCell>
						</TableRow>
					))}
				</TableBody>
			</Table>
		</div>
	)
}
