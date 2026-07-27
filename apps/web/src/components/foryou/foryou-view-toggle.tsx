import { Button } from '@/components/ui/button'
import { cn } from '@/lib/cn'
import { LayoutGrid, List } from 'lucide-react'

export type ForYouViewMode = 'card' | 'list'

interface ForYouViewToggleProps {
	value: ForYouViewMode
	onChange: (mode: ForYouViewMode) => void
	className?: string
}

// Segmented Card/List toggle for the For You page header. Pure controlled input:
// value + onChange live in the parent (T4 wires them to server-side display
// settings). Sized to match the sibling header buttons ("Mark all as read", "New")
// so it drops into the same action row without breaking the rhythm.
export function ForYouViewToggle({ value, onChange, className }: ForYouViewToggleProps) {
	return (
		// biome-ignore lint/a11y/useSemanticElements: <fieldset> is meant for form controls; a segmented view toggle is more idiomatic as role="group" — matches FilterTabs.
		<div
			role="group"
			aria-label="For You view mode"
			className={cn('inline-flex items-center gap-0.5', className)}
		>
			<ToggleButton
				mode="card"
				label="Card view"
				icon={<LayoutGrid size={14} aria-hidden />}
				active={value === 'card'}
				onChange={onChange}
			/>
			<ToggleButton
				mode="list"
				label="List view"
				icon={<List size={14} aria-hidden />}
				active={value === 'list'}
				onChange={onChange}
			/>
		</div>
	)
}

interface ToggleButtonProps {
	mode: ForYouViewMode
	label: string
	icon: React.ReactNode
	active: boolean
	onChange: (mode: ForYouViewMode) => void
}

function ToggleButton({ mode, label, icon, active, onChange }: ToggleButtonProps) {
	return (
		<Button
			type="button"
			variant="ghost"
			size="sm"
			aria-label={label}
			aria-pressed={active}
			onClick={() => onChange(mode)}
			className={cn('h-7 px-2 text-xs', active && 'bg-secondary/40 text-foreground')}
		>
			{icon}
		</Button>
	)
}
