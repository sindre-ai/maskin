import { cn } from '@/lib/cn'

interface FormErrorProps {
	error?: string | string[]
	className?: string
}

export function FormError({ error, className }: FormErrorProps) {
	if (!error) return null
	const messages = Array.isArray(error) ? error : [error]
	return (
		<div className={cn('text-xs text-error mt-1', className)}>
			{messages.map((msg) => (
				<p key={msg}>{msg}</p>
			))}
		</div>
	)
}
