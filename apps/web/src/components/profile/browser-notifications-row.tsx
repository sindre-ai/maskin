import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { useWebPush } from '@/hooks/use-web-push'
import { ApiError } from '@/lib/api'
import { toast } from 'sonner'

/**
 * The control half of the "Browser notifications" row (the label and section live in
 * profile-view.tsx). It is per browser, not per account: turning it on subscribes only this
 * browser. The Profile section is hidden while `useWebPush().state` is `unavailable`, so the
 * control never appears where it cannot work.
 */
export function BrowserNotificationsToggle() {
	const { state, isLoading, enable, disable } = useWebPush()
	const pending = isLoading || enable.isPending || disable.isPending

	function toggle(next: boolean) {
		if (next) {
			enable.mutate(undefined, {
				onSuccess: (outcome) => {
					if (outcome === 'denied') {
						toast.error('Notifications are blocked — allow them in your browser’s site settings')
					} else {
						toast.success('Browser notifications are on')
					}
				},
				onError: (err) =>
					toast.error(err instanceof ApiError ? err.message : 'Couldn’t turn on notifications'),
			})
		} else {
			disable.mutate(undefined, {
				onSuccess: () => toast.success('Browser notifications are off'),
				onError: () => toast.error('Couldn’t turn off notifications'),
			})
		}
	}

	return (
		<>
			{state === 'blocked' && (
				<span className="text-[11px] text-muted-foreground">Blocked in site settings</span>
			)}
			{pending && <Spinner className="size-3.5" />}
			<Switch
				checked={state === 'on'}
				disabled={pending || state === 'blocked'}
				onCheckedChange={toggle}
				aria-label="Browser notifications"
			/>
		</>
	)
}
