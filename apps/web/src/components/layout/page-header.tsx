import { usePageHeader } from '@/lib/page-header-context'
import { useEffect } from 'react'

export function PageHeader({
	title,
	actions,
}: {
	title?: string
	actions?: React.ReactNode
}) {
	const { setActions, setTitle } = usePageHeader()

	useEffect(() => {
		setActions(actions ?? null)
		return () => setActions(null)
	}, [actions, setActions])

	useEffect(() => {
		setTitle(title)
		return () => setTitle(undefined)
	}, [title, setTitle])

	return null
}
