import { Badge } from '@/components/ui/badge'
import { Spinner } from '@/components/ui/spinner'

export function AgentWorkingBadge() {
	return (
		<Badge variant="secondary" className="gap-1">
			<Spinner />
			Agent working
		</Badge>
	)
}
