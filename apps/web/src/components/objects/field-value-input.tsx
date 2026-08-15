import { Input } from '@/components/ui/input'
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from '@/components/ui/select'
import { cn } from '@/lib/cn'

export interface FieldDefinition {
	name: string
	type: 'text' | 'number' | 'date' | 'enum' | 'boolean'
	required?: boolean
	values?: string[]
}

interface FieldValueInputProps {
	type: FieldDefinition['type']
	value: string
	fieldDef?: FieldDefinition
	onChange: (value: string) => void
	placeholder?: string
	className?: string
	autoFocus?: boolean
	onBlur?: () => void
	onKeyDown?: (e: React.KeyboardEvent) => void
	// Editing use-cases open the Select immediately and treat a close as a cancel.
	selectDefaultOpen?: boolean
	onSelectOpenChange?: (open: boolean) => void
}

/**
 * Renders the right control for a workspace field's `type` as a controlled
 * string input. Used both as a filter control (Display panel) and inside the
 * metadata property editor, so the type→control mapping lives in one place.
 * `value === ''` means "no value" (placeholder shown).
 */
export function FieldValueInput({
	type,
	value,
	fieldDef,
	onChange,
	placeholder = 'Any',
	className,
	autoFocus,
	onBlur,
	onKeyDown,
	selectDefaultOpen,
	onSelectOpenChange,
}: FieldValueInputProps) {
	switch (type) {
		case 'boolean':
			return (
				<Select
					value={value}
					defaultOpen={selectDefaultOpen}
					onValueChange={onChange}
					onOpenChange={onSelectOpenChange}
				>
					<SelectTrigger className={className}>
						<SelectValue placeholder={placeholder} />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value="true">Yes</SelectItem>
						<SelectItem value="false">No</SelectItem>
					</SelectContent>
				</Select>
			)
		case 'enum':
			return (
				<Select
					value={value}
					defaultOpen={selectDefaultOpen}
					onValueChange={onChange}
					onOpenChange={onSelectOpenChange}
				>
					<SelectTrigger className={className}>
						<SelectValue placeholder={placeholder} />
					</SelectTrigger>
					<SelectContent>
						{(fieldDef?.values ?? []).map((v) => (
							<SelectItem key={v} value={v}>
								{v}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			)
		case 'date':
			return (
				<Input
					type="date"
					value={value ? value.slice(0, 10) : ''}
					onChange={(e) => onChange(e.target.value)}
					className={cn('h-8 text-sm', className)}
					autoFocus={autoFocus}
					onBlur={onBlur}
					onKeyDown={onKeyDown}
				/>
			)
		case 'number':
			return (
				<Input
					type="number"
					value={value}
					onChange={(e) => onChange(e.target.value)}
					placeholder={placeholder}
					className={cn('h-8 text-sm', className)}
					autoFocus={autoFocus}
					onBlur={onBlur}
					onKeyDown={onKeyDown}
				/>
			)
		default:
			return (
				<Input
					type="text"
					value={value}
					onChange={(e) => onChange(e.target.value)}
					placeholder={placeholder}
					className={cn('h-8 text-sm', className)}
					autoFocus={autoFocus}
					onBlur={onBlur}
					onKeyDown={onKeyDown}
				/>
			)
	}
}
