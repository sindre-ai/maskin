import { usePageHeader } from '@/lib/page-header-context'
import { useEffect } from 'react'

export function PageHeader({
	actions,
	stickyIdentity,
}: {
	title?: string
	actions?: React.ReactNode
	stickyIdentity?: React.ReactNode
}) {
	const { setActions, setStickyIdentity } = usePageHeader()

	useEffect(() => {
		setActions(actions ?? null)
		return () => setActions(null)
	}, [actions, setActions])

	useEffect(() => {
		setStickyIdentity(stickyIdentity ?? null)
		return () => setStickyIdentity(null)
	}, [stickyIdentity, setStickyIdentity])

	return null
}
