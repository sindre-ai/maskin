import { Button } from '@/components/ui/button'
import { Calendar } from '@/components/ui/calendar'
import {
	ResponsivePopover,
	ResponsivePopoverContent,
	ResponsivePopoverTrigger,
} from '@/components/ui/responsive-popover'
import { format } from 'date-fns'
import { CalendarIcon } from 'lucide-react'
import { useState } from 'react'
import type { DateRange } from 'react-day-picker'

export type DateRangeValue = { from: Date; to: Date }

export function DateRangePicker({
	value,
	onChange,
	maxDays,
	className,
}: {
	value: DateRangeValue
	onChange: (range: DateRangeValue) => void
	maxDays?: number
	className?: string
}) {
	const [open, setOpen] = useState(false)
	const label =
		value.from.toDateString() === value.to.toDateString()
			? format(value.from, 'LLL d, yyyy')
			: `${format(value.from, 'LLL d')} – ${format(value.to, 'LLL d, yyyy')}`

	const handleSelect = (range: DateRange | undefined) => {
		if (!range?.from || !range?.to) return
		onChange({ from: range.from, to: range.to })
		setOpen(false)
	}

	return (
		<ResponsivePopover open={open} onOpenChange={setOpen}>
			<ResponsivePopoverTrigger asChild>
				<Button variant="outline" size="sm" className={className}>
					<CalendarIcon size={14} />
					<span className="ml-1.5">{label}</span>
				</Button>
			</ResponsivePopoverTrigger>
			<ResponsivePopoverContent
				align="end"
				accessibleTitle="Date range"
				className="md:w-auto md:p-0"
			>
				<Calendar
					mode="range"
					numberOfMonths={2}
					defaultMonth={value.from}
					selected={value}
					onSelect={handleSelect}
					disabled={
						maxDays
							? (date) => {
									const diff = Math.abs(date.getTime() - value.from.getTime()) / 86_400_000
									return diff > maxDays
								}
							: undefined
					}
				/>
			</ResponsivePopoverContent>
		</ResponsivePopover>
	)
}
