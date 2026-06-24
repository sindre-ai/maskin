import type { ImportPreviewDiffRow } from '@/lib/api'
import { cn } from '@/lib/cn'
import { forwardRef } from 'react'

interface ImportDiffTableProps {
	diffs: ImportPreviewDiffRow[]
	className?: string
}

function formatValue(value: unknown): string {
	if (value === null || value === undefined || value === '') return '—'
	if (typeof value === 'string') return value
	return JSON.stringify(value)
}

export const ImportDiffTable = forwardRef<HTMLDivElement, ImportDiffTableProps>(
	function ImportDiffTable({ diffs, className }, ref) {
		if (diffs.length === 0) {
			return (
				<div
					ref={ref}
					className={cn(
						'rounded-lg border bg-card p-6 text-center text-sm text-muted-foreground',
						className,
					)}
				>
					No matched rows to preview.
				</div>
			)
		}

		return (
			<div ref={ref} className={cn('rounded-lg border bg-card overflow-x-auto', className)}>
				<table className="w-full text-xs">
					<thead className="sticky top-0 bg-muted/50">
						<tr>
							<th className="hidden sm:table-cell px-3 py-2 text-left font-medium text-muted-foreground uppercase tracking-wide w-14">
								Row
							</th>
							<th className="px-3 py-2 text-left font-medium text-muted-foreground uppercase tracking-wide">
								Changes
							</th>
						</tr>
					</thead>
					<tbody>
						{diffs.map((diff) => (
							<tr key={`${diff.object_id}-${diff.row_index}`} className="border-t">
								<td className="hidden sm:table-cell px-3 py-2 align-top font-mono text-muted-foreground">
									{diff.row_index + 1}
								</td>
								<td className="px-3 py-2 align-top">
									<div className="flex flex-col gap-1">
										{diff.changes.map((change) => (
											<div key={`${change.column}`} className="flex flex-wrap items-baseline gap-1">
												<span className="font-mono text-muted-foreground">{change.column}:</span>
												<span className="text-muted-foreground line-through">
													{formatValue(change.old)}
												</span>
												<span className="text-muted-foreground">→</span>
												<span className="font-medium text-foreground">
													{formatValue(change.new)}
												</span>
											</div>
										))}
									</div>
								</td>
							</tr>
						))}
					</tbody>
				</table>
			</div>
		)
	},
)
