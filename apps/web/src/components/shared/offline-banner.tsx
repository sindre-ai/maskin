import { useOnlineStatus } from '@/hooks/use-online-status'
import { useServerReachability } from '@/hooks/use-server-reachability'
import { CloudOff, WifiOff } from 'lucide-react'

// Same wording as the iOS banner ("Can't reach Maskin. Showing what we had at
// 08:14."), minus its "Decisions queue offline." sentence: the web app has no
// offline queue to promise.
function serverMessage(lastOkAt: number | null): string {
	if (lastOkAt === null) return 'Can’t reach Maskin. Trying again…'
	const time = new Date(lastOkAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
	return `Can’t reach Maskin. Showing what we had at ${time}.`
}

export function OfflineBanner() {
	const isOnline = useOnlineStatus()
	const server = useServerReachability()

	// A device with no network is its own, clearer problem; say that first.
	if (isOnline && !server.unreachable) return null

	const Icon = isOnline ? CloudOff : WifiOff

	return (
		<output className="fixed top-0 left-0 right-0 z-50 flex items-center justify-center gap-2 bg-warning px-4 py-2 text-sm font-medium text-bg">
			<Icon size={14} className="shrink-0" />
			{isOnline
				? serverMessage(server.lastOkAt)
				: 'You are offline. Changes will sync when reconnected.'}
		</output>
	)
}
