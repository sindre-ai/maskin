import { cn } from '@/lib/cn'

export function Spinner({ className, ...props }: React.ComponentProps<'svg'>) {
	return (
		<svg
			viewBox="0 0 16 16"
			fill="none"
			className={cn('size-3.5 animate-spin', className)}
			{...props}
		>
			<title>Loading</title>
			<circle cx="8" cy="8" r="6" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2.5" />
			<path d="M8 2a6 6 0 0 1 6 6" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
		</svg>
	)
}
