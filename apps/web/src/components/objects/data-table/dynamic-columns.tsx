import { RelativeTime } from '@/components/shared/relative-time'
import type { ObjectResponse } from '@/lib/api'
import type { ColumnDef } from '@tanstack/react-table'

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

	return fields.map((field) => ({
		id: `metadata.${field.name}`,
		accessorFn: (row: ObjectResponse) =>
			(row.metadata as Record<string, unknown> | null)?.[field.name] ?? null,
		header: field.name.replace(/_/g, ' '),
		cell: ({ getValue }: { getValue: () => unknown }) => renderFieldValue(getValue(), field.type),
		enableSorting: false,
		enableHiding: true,
		meta: { fieldType: field.type, isDynamic: true },
	}))
}
