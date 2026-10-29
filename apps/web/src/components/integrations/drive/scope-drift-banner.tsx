import { Button } from '@/components/ui/button'
import { AlertTriangle } from 'lucide-react'

/** The one banner for "this connection needs the human to do something at
 *  Google": add a permission, or reconnect after the grant was invalidated.
 *  Announced politely so it appears without pulling focus. */
export function ScopeDriftBanner({
	title,
	body,
	ctaLabel,
	onCta,
	ctaPending,
	testId = 'scope-drift-banner',
}: {
	title: string
	body: string
	ctaLabel: string
	onCta: () => void
	ctaPending?: boolean
	testId?: string
}) {
	return (
		<output
			className="flex flex-col gap-2 rounded-md border border-warning/40 bg-warning/10 p-3 text-warning md:flex-row md:items-center md:gap-4"
			aria-live="polite"
			data-testid={testId}
		>
			<AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
			<div className="min-w-0 flex-1">
				<p className="text-sm font-medium">{title}</p>
				<p className="text-xs opacity-80">{body}</p>
			</div>
			<Button
				size="sm"
				variant="outline"
				className="shrink-0"
				onClick={onCta}
				disabled={ctaPending}
			>
				{ctaLabel}
			</Button>
		</output>
	)
}
