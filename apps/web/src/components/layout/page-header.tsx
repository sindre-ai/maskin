import { usePageHeader } from '@/lib/page-header-context'
import { useEffect } from 'react'

export function PageHeader({
	actions,
}: {
	title?: string
	actions?: React.ReactNode
}) {
	const { setActions } = usePageHeader()

	useEffect(() => {
		setActions(actions ?? null)
		return () => setActions(null)
	}, [actions, setActions])

	return null
}
