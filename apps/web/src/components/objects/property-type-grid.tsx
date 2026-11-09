import { RadioGroup } from '@/components/ui/radio-group'
import { cn } from '@/lib/cn'
import * as RadioGroupPrimitive from '@radix-ui/react-radio-group'
import { AlignLeft, CalendarDays, CheckSquare, Hash, Layers } from 'lucide-react'

export type PropertyType = 'text' | 'number' | 'date' | 'enum' | 'boolean'

// The types the workspace field schema accepts (packages/shared workspaces.ts).
// v3 also draws Person and URL tiles; they need new field types on the backend.
const PROPERTY_TYPES: { value: PropertyType; label: string; icon: typeof Hash }[] = [
	{ value: 'text', label: 'Text', icon: AlignLeft },
	{ value: 'number', label: 'Number', icon: Hash },
	{ value: 'date', label: 'Date', icon: CalendarDays },
	{ value: 'enum', label: 'Select', icon: Layers },
	{ value: 'boolean', label: 'Yes / No', icon: CheckSquare },
]

/** Label a stored field type the way the grid names it. */
export function propertyTypeLabel(type: PropertyType): string {
	return PROPERTY_TYPES.find((t) => t.value === type)?.label ?? type
}

/** The Add property dialog's type picker: one tile per field type, three to a row. */
export function PropertyTypeGrid({
	value,
	onChange,
	disabled,
	'aria-label': ariaLabel = 'Type',
}: {
	value: PropertyType
	onChange: (value: PropertyType) => void
	disabled?: boolean
	'aria-label'?: string
}) {
	return (
		<RadioGroup
			value={value}
			onValueChange={(next) => onChange(next as PropertyType)}
			disabled={disabled}
			aria-label={ariaLabel}
			className="grid-cols-3 gap-2"
		>
			{PROPERTY_TYPES.map(({ value: type, label, icon: Icon }) => (
				<RadioGroupPrimitive.Item
					key={type}
					value={type}
					className={cn(
						'flex min-h-11 flex-col items-center justify-center gap-1 rounded-lg border px-2 py-2.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50',
						value === type
							? 'border-foreground bg-card text-foreground'
							: 'border-border text-muted-foreground hover:border-border-strong hover:text-foreground',
					)}
				>
					<Icon size={15} aria-hidden />
					{label}
				</RadioGroupPrimitive.Item>
			))}
		</RadioGroup>
	)
}
