import { useOnlineStatus } from '@/hooks/use-online-status'
import { WifiOff } from 'lucide-react'

export function OfflineBanner() {
	const isOnline = useOnlineStatus()

	if (isOnline) return null

	return (
		<div className="fixed top-0 left-0 right-0 z-50 flex items-center justify-center gap-2 bg-warning px-4 py-2 text-sm font-medium text-bg">
			<WifiOff size={14} />
			You are offline. Changes will sync when reconnected.
		</div>
	)
}
