import { Button } from '@/components/ui/button'

const filters = [
	{ label: 'All', value: 'all' },
	{ label: 'Needs you', value: 'needs_input' },
	{ label: 'Recommendations', value: 'recommendation' },
	{ label: 'Alerts', value: 'alert' },
	{ label: 'Good news', value: 'good_news' },
	{ label: 'Alerts', value: 'alert' },
] as const

interface NotificationFiltersProps {
	active: string
	onChange: (value: string) => void
	counts: Record<string, number>
}

export function NotificationFilters({ active, onChange, counts }: NotificationFiltersProps) {
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
