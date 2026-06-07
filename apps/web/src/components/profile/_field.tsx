import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { cn } from '@/lib/cn'
import type { HTMLInputTypeAttribute } from 'react'

interface FieldProps {
	id: string
	label: string
	value: string
	onChange: (value: string) => void
	onBlur?: () => void
	error?: string | null
	hint?: string
	autoComplete?: string
	type?: HTMLInputTypeAttribute
}

// Shared label + input + inline error block for the profile row dialogs.
// The inline span layout is structurally different from the multi-line
// `<FormError>` in shared/, so the field-level error lives here alongside
// the input it annotates.
export function Field({
	id,
	label,
	value,
	onChange,
	onBlur,
	error,
	hint,
	autoComplete,
	type = 'text',
}: FieldProps) {
	return (
		<div className="flex flex-col gap-1">
			<Label htmlFor={id}>{label}</Label>
			<Input
				id={id}
				type={type}
				value={value}
				onChange={(e) => onChange(e.target.value)}
				onBlur={onBlur}
				autoComplete={autoComplete}
				aria-invalid={error ? true : undefined}
				className={cn(error && 'border-destructive')}
			/>
			{error ? (
				<span className="text-xs text-destructive">{error}</span>
			) : hint ? (
				<span className="text-xs text-muted-foreground/80">{hint}</span>
			) : null}
		</div>
	)
}
