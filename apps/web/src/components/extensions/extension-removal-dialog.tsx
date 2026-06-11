import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import {
	ResponsiveDialog,
	ResponsiveDialogContent,
	ResponsiveDialogDescription,
	ResponsiveDialogFooter,
	ResponsiveDialogHeader,
	ResponsiveDialogTitle,
} from '@/components/ui/responsive-dialog'
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from '@/components/ui/select'
import { Spinner } from '@/components/ui/spinner'
import { useAvailableObjectTypes } from '@/hooks/use-available-object-types'
import { useMigrateObjectType } from '@/hooks/use-objects'
import { api } from '@/lib/api'
import { useQueries } from '@tanstack/react-query'
import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'

type Choice =
	| { kind: 'migrate'; toType: string; statusMap: Record<string, string> }
	| { kind: 'delete' }
	| { kind: 'keep' }

interface ExtensionRemovalDialogProps {
	open: boolean
	onOpenChange: (open: boolean) => void
	/** Types whose extension is about to be removed/disabled. */
	affectedTypes: string[]
	/** Workspace id used for object lookups + migration. */
	workspaceId: string
	/** Workspace settings, used to read display names + statuses. */
	settings: Record<string, unknown>
	/** Called after the user has resolved every affected type and migrations succeeded.
	 *  Parent is responsible for stripping settings + persisting the toggle/delete. */
	onConfirmed: () => void | Promise<void>
}

export function ExtensionRemovalDialog({
	open,
	onOpenChange,
	affectedTypes,
	workspaceId,
	settings,
	onConfirmed,
}: ExtensionRemovalDialogProps) {
	const displayNames = (settings?.display_names as Record<string, string>) ?? {}
	const statuses = (settings?.statuses as Record<string, string[]>) ?? {}
	const allTypes = useAvailableObjectTypes()
	const migrateMutation = useMigrateObjectType(workspaceId)

	// Target types must NOT include any of the types being removed.
	const targetTypes = useMemo(
		() => allTypes.filter((t) => !affectedTypes.includes(t.value)),
		[allTypes, affectedTypes],
	)

	// Per-type counts. Skip query when the dialog isn't open.
	// Fetch one extra row past the cap so we can show "100+" instead of an
	// undercount when the user has more objects than the page size.
	const COUNT_CAP = 100
	const countQueries = useQueries({
		queries: affectedTypes.map((type) => ({
			queryKey: ['objects', workspaceId, 'count-by-type', type] as const,
			queryFn: async () => {
				const rows = await api.objects.list(workspaceId, {
					type,
					limit: String(COUNT_CAP + 1),
				})
				return { count: Math.min(rows.length, COUNT_CAP), hasMore: rows.length > COUNT_CAP }
			},
			enabled: open,
		})),
	})

	const formatCount = (data: { count: number; hasMore: boolean } | undefined) => {
		if (!data) return '0 objects'
		const suffix = data.hasMore ? '+' : ''
		return `${data.count}${suffix} object${data.count === 1 && !data.hasMore ? '' : 's'}`
	}

	const [choices, setChoices] = useState<Record<string, Choice>>({})
	const [submitting, setSubmitting] = useState(false)

	// Reset choices whenever the dialog opens for a new set of types
	useEffect(() => {
		if (open) setChoices({})
	}, [open])

	// Types with no existing objects don't need a choice — auto-resolve them.
	const allResolved = affectedTypes.every((t, idx) => {
		const data = countQueries[idx]?.data
		if (data && data.count === 0 && !data.hasMore) return true
		const c = choices[t]
		if (!c) return false
		if (c.kind === 'migrate') return !!c.toType
		return true
	})

	const stillCounting = countQueries.some((q) => q.isLoading)

	const setChoice = (type: string, choice: Choice) => {
		setChoices((prev) => ({ ...prev, [type]: choice }))
	}

	const handleConfirm = async () => {
		setSubmitting(true)
		try {
			for (const type of affectedTypes) {
				const choice = choices[type]
				if (!choice || choice.kind === 'keep') continue
				if (choice.kind === 'delete') {
					await migrateMutation.mutateAsync({ fromType: type, mode: 'delete' })
				} else {
					await migrateMutation.mutateAsync({
						fromType: type,
						mode: 'migrate',
						toType: choice.toType,
						statusMap: choice.statusMap,
					})
				}
			}
			await onConfirmed()
			onOpenChange(false)
		} catch (err) {
			toast.error(err instanceof Error ? err.message : 'Failed to apply changes')
		} finally {
			setSubmitting(false)
		}
	}

	return (
		<ResponsiveDialog open={open} onOpenChange={onOpenChange}>
			<ResponsiveDialogContent className="md:max-w-xl">
				<ResponsiveDialogHeader>
					<ResponsiveDialogTitle>Remove extension</ResponsiveDialogTitle>
					<ResponsiveDialogDescription>
						{affectedTypes.length === 1
							? 'This extension defines an object type that has existing data. Choose what to do with it.'
							: 'This extension defines object types that have existing data. Choose what to do with each.'}
					</ResponsiveDialogDescription>
				</ResponsiveDialogHeader>

				<div className="space-y-4 max-h-[60vh] overflow-y-auto">
					{affectedTypes.map((type, idx) => {
						const countQuery = countQueries[idx]
						const data = countQuery?.data
						const isEmpty = !!data && data.count === 0 && !data.hasMore
						const label = displayNames[type] ?? type
						const choice = choices[type]
						const sourceStatuses = statuses[type] ?? []
						const targetStatuses = choice?.kind === 'migrate' ? (statuses[choice.toType] ?? []) : []
						const unmappedStatuses = sourceStatuses.filter((s) => !targetStatuses.includes(s))

						return (
							<div key={type} className="rounded-lg border border-border p-4">
								<div className="flex items-center justify-between mb-3">
									<div>
										<div className="text-sm font-medium capitalize">{label}</div>
										<div className="text-xs text-muted-foreground">
											{countQuery?.isLoading ? 'Counting…' : formatCount(data)}
										</div>
									</div>
								</div>

								{isEmpty ? (
									<p className="text-xs text-muted-foreground">
										No objects to migrate. The extension will be removed.
									</p>
								) : (
									<RadioGroup
										value={choice?.kind ?? ''}
										onValueChange={(kind) => {
											if (kind === 'migrate') {
												const firstTarget = targetTypes[0]?.value ?? ''
												setChoice(type, { kind: 'migrate', toType: firstTarget, statusMap: {} })
											} else if (kind === 'delete') {
												setChoice(type, { kind: 'delete' })
											} else if (kind === 'keep') {
												setChoice(type, { kind: 'keep' })
											}
										}}
										className="space-y-2"
									>
										<div className="flex items-start gap-2">
											<RadioGroupItem value="migrate" id={`${type}-migrate`} className="mt-1" />
											<div className="flex-1">
												<Label htmlFor={`${type}-migrate`} className="text-sm font-normal">
													Migrate to a different type
												</Label>
												{choice?.kind === 'migrate' && (
													<div className="mt-2 space-y-3">
														{targetTypes.length === 0 ? (
															<p className="text-xs text-error">
																No remaining object types to migrate to.
															</p>
														) : (
															<Select
																value={choice.toType}
																onValueChange={(toType) =>
																	setChoice(type, { ...choice, toType, statusMap: {} })
																}
															>
																<SelectTrigger>
																	<SelectValue placeholder="Pick a type" />
																</SelectTrigger>
																<SelectContent>
																	{targetTypes.map((t) => (
																		<SelectItem key={t.value} value={t.value}>
																			{t.label}
																		</SelectItem>
																	))}
																</SelectContent>
															</Select>
														)}

														{choice.toType && unmappedStatuses.length > 0 && (
															<div className="space-y-2">
																<p className="text-xs text-muted-foreground">
																	Map statuses that don't exist on the target type:
																</p>
																<div className="space-y-1">
																	{unmappedStatuses.map((srcStatus) => (
																		<div
																			key={srcStatus}
																			className="flex items-center gap-2 text-xs"
																		>
																			<span className="font-mono text-muted-foreground w-32 truncate">
																				{srcStatus}
																			</span>
																			<span className="text-muted-foreground">→</span>
																			<Select
																				value={
																					choice.statusMap[srcStatus] ?? targetStatuses[0] ?? ''
																				}
																				onValueChange={(v) =>
																					setChoice(type, {
																						...choice,
																						statusMap: { ...choice.statusMap, [srcStatus]: v },
																					})
																				}
																			>
																				<SelectTrigger className="flex-1">
																					<SelectValue />
																				</SelectTrigger>
																				<SelectContent>
																					{targetStatuses.map((s) => (
																						<SelectItem key={s} value={s}>
																							{s}
																						</SelectItem>
																					))}
																				</SelectContent>
																			</Select>
																		</div>
																	))}
																</div>
															</div>
														)}
													</div>
												)}
											</div>
										</div>

										<div className="flex items-start gap-2">
											<RadioGroupItem value="delete" id={`${type}-delete`} className="mt-1" />
											<Label htmlFor={`${type}-delete`} className="text-sm font-normal">
												Delete {formatCount(data)} <span className="text-error">(permanent)</span>
											</Label>
										</div>

										<div className="flex items-start gap-2">
											<RadioGroupItem value="keep" id={`${type}-keep`} className="mt-1" />
											<Label htmlFor={`${type}-keep`} className="text-sm font-normal">
												Keep as orphans
												<span className="block text-xs text-muted-foreground">
													Objects stay but won't load until the type is restored.
												</span>
											</Label>
										</div>
									</RadioGroup>
								)}
							</div>
						)
					})}
				</div>

				<ResponsiveDialogFooter>
					<Button variant="ghost" onClick={() => onOpenChange(false)} disabled={submitting}>
						Cancel
					</Button>
					<Button onClick={handleConfirm} disabled={!allResolved || submitting || stillCounting}>
						{submitting ? <Spinner /> : 'Confirm removal'}
					</Button>
				</ResponsiveDialogFooter>
			</ResponsiveDialogContent>
		</ResponsiveDialog>
	)
}
