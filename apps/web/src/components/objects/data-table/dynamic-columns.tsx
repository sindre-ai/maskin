import { RelativeTime } from '@/components/shared/relative-time'
import { Badge } from '@/components/ui/badge'
import type { ObjectResponse } from '@/lib/api'
import type { ColumnDef, Table } from '@tanstack/react-table'
import { type ObjectsTableMeta, SortableHeader } from './columns'

interface FieldDefinition {
	name: string
	type: 'text' | 'number' | 'date' | 'enum' | 'boolean'
	required?: boolean
	values?: string[]
}

// Fields that carry a comma-separated tag list — rendered as a compact chip
// row rather than a raw string. Keyed by field name so tag-shaped fields
// across types render the same way without introducing a new schema type.
const TAG_LIST_FIELD_NAMES = new Set(['provenance'])

function renderTagList(value: unknown): React.ReactNode {
	const tags = String(value)
		.split(',')
		.map((t) => t.trim())
		.filter(Boolean)
	if (tags.length === 0) return <span className="text-muted-foreground">—</span>
	return (
		<div className="flex flex-wrap gap-1">
			{tags.map((tag) => (
				<Badge key={tag} variant="secondary" className="text-[10px] px-1.5 py-0 font-normal">
					{tag}
				</Badge>
			))}
		</div>
	)
}

function renderFieldValue(value: unknown, type: string, fieldName: string): React.ReactNode {
	if (value == null) return <span className="text-muted-foreground">—</span>
	if (TAG_LIST_FIELD_NAMES.has(fieldName)) return renderTagList(value)
	switch (type) {
		case 'date':
			return <RelativeTime date={String(value)} className="text-sm text-muted-foreground" />
		case 'boolean':
			return <span className="text-sm">{value ? 'Yes' : 'No'}</span>
		case 'number':
			return <span className="text-sm tabular-nums">{String(value)}</span>
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
		const accessorFn = (row: ObjectResponse) =>
			(row.metadata as Record<string, unknown> | null)?.[field.name] ?? null
		return {
			id: columnId,
			accessorFn,
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
			cell: ({ getValue }: { getValue: () => unknown }) =>
				renderFieldValue(getValue(), field.type, field.name),
			...(field.type === 'date' && {
				getGroupingValue: (row: ObjectResponse) => {
					const val = accessorFn(row)
					if (!val) return ''
					const d = new Date(String(val))
					return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
				},
			}),
			enableSorting: false,
			enableHiding: true,
			meta: { fieldType: field.type, isDynamic: true },
		}
	})
}
