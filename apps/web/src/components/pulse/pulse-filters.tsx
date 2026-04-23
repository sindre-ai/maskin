import { Button } from '@/components/ui/button'

const filters = [
	{ label: 'All', value: 'all' },
	{ label: 'Needs you', value: 'needs_input' },
	{ label: 'Mentions', value: 'mention' },
	{ label: 'Recommendations', value: 'recommendation' },
	{ label: 'Alerts', value: 'alert' },
	{ label: 'Good news', value: 'good_news' },
] as const

interface PulseFiltersProps {
	active: string
	onChange: (value: string) => void
	counts: Record<string, number>
}

export function PulseFilters({ active, onChange, counts }: PulseFiltersProps) {
	return (
		<div className="flex gap-2 mb-6">
			{filters.map((f) => {
				const count = f.value === 'all' ? counts.all : (counts[f.value] ?? 0)
				return (
					<Button
						key={f.value}
						variant={active === f.value ? 'default' : 'outline'}
						size="sm"
						onClick={() => onChange(f.value)}
					>
						{f.label} {count}
					</Button>
				)
			})}
		</div>
	)
}
