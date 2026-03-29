import { RelativeTime } from '@/components/shared/relative-time'
import type { ObjectResponse } from '@/lib/api'
import type { ColumnDef, Table } from '@tanstack/react-table'
import { type ObjectsTableMeta, SortableHeader } from './columns'

interface FieldDefinition {
	name: string
	type: 'text' | 'number' | 'date' | 'enum' | 'boolean'
	required?: boolean
	values?: string[]
}

function renderFieldValue(value: unknown, type: string): React.ReactNode {
	if (value == null) return <span className="text-muted-foreground">—</span>
	switch (type) {
		case 'date':
			return <RelativeTime date={String(value)} className="text-sm text-muted-foreground" />
		case 'boolean':
			return <span className="text-sm">{value ? 'Yes' : 'No'}</span>
		case 'number':
			return <span className="text-sm">{String(value)}</span>
		default:
			return <span className="text-sm">{String(value)}</span>
	}
}

function deduplicateFields(fields: FieldDefinition[]): FieldDefinition[] {
	const seen = new Set<string>()
	return fields.filter((f) => {
		if (seen.has(f.name)) return false
		seen.add(f.name)
		return true
	})
}

export function getDynamicColumns(
	fieldDefinitions: Record<string, FieldDefinition[]> | undefined,
	typeFilter?: string,
): ColumnDef<ObjectResponse>[] {
	if (!fieldDefinitions) return []

	const fields = typeFilter
		? (fieldDefinitions[typeFilter] ?? [])
		: deduplicateFields(Object.values(fieldDefinitions).flat())

	return fields.map((field) => {
		const columnId = `metadata.${field.name}`
		const label = field.name.replace(/_/g, ' ')
		return {
			id: columnId,
			accessorFn: (row: ObjectResponse) =>
				(row.metadata as Record<string, unknown> | null)?.[field.name] ?? null,
			header: ({ table }: { table: Table<ObjectResponse> }) => {
				const meta = table.options.meta as ObjectsTableMeta | undefined
				return (
					<SortableHeader
						label={label}
						columnId={columnId}
						currentSort={meta?.currentSort}
						currentOrder={meta?.currentOrder}
						onSort={meta?.onSort}
					/>
				)
			},
			cell: ({ getValue }: { getValue: () => unknown }) => renderFieldValue(getValue(), field.type),
			enableSorting: false,
			enableHiding: true,
			meta: { fieldType: field.type, isDynamic: true },
		}
	})
}
