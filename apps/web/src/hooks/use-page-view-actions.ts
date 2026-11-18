import type { LoopView } from '@maskin/shared'
import { useCallback, useState } from 'react'
import { toast } from 'sonner'

/**
 * Rename and remove for the view tabs on a list or an item page, the same as on a flow: the
 * stored list is re-read first (an agent may have attached a view since the page loaded, and the
 * write replaces the whole list), and removing leaves the file alone and offers Undo.
 */
export function usePageViewActions({
	readStored,
	write,
}: {
	/** The views as stored right now. */
	readStored: () => Promise<LoopView[]>
	/** Saves the whole list. */
	write: (views: LoopView[]) => Promise<void>
}) {
	const [busy, setBusy] = useState(false)

	const save = useCallback(
		async (
			change: (current: LoopView[]) => LoopView[] | null,
			failure: string,
		): Promise<LoopView[] | null> => {
			setBusy(true)
			try {
				const current = await readStored()
				const next = change(current)
				if (!next) return null
				await write(next)
				return current
			} catch {
				toast.error(failure)
				return null
			} finally {
				setBusy(false)
			}
		},
		[readStored, write],
	)

	/** Resolves true once saved, so the rename field stays open (with the typed name) otherwise. */
	const rename = useCallback(
		async (fileId: string, name: string) => {
			const saved = await save((current) => {
				if (
					current.some((v) => v.fileId !== fileId && v.name.toLowerCase() === name.toLowerCase())
				) {
					toast.error('Another view already has that name')
					return null
				}
				return current.map((v) => (v.fileId === fileId ? { ...v, name } : v))
			}, 'Could not rename the view')
			return saved !== null
		},
		[save],
	)

	/** Resolves true once removed. */
	const remove = useCallback(
		async (fileId: string) => {
			const previous = await save(
				(current) => current.filter((v) => v.fileId !== fileId),
				'Could not remove the view',
			)
			if (!previous) return false
			toast.success('View removed', {
				duration: 15_000,
				action: {
					label: 'Undo',
					onClick: () => write(previous).catch(() => toast.error('Could not restore the view')),
				},
			})
			return true
		},
		[save, write],
	)

	return { rename, remove, busy }
}
