import { ExtensionRemovalDialog } from '@/components/extensions/extension-removal-dialog'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { useCustomExtensions } from '@/hooks/use-custom-extensions'
import { useEnabledModules } from '@/hooks/use-enabled-modules'
import { useUpdateWorkspace } from '@/hooks/use-workspaces'
import { useWorkspace } from '@/lib/workspace-context'
import { getAllWebModules, getWebModule } from '@maskin/module-sdk'
import { Trash2 } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'

interface PendingRemoval {
	affectedTypes: string[]
	commit: () => void
}

export function ExtensionsSection() {
	const { workspace, workspaceId } = useWorkspace()
	const updateWorkspace = useUpdateWorkspace(workspaceId)
	const settings = workspace.settings as Record<string, unknown>
	const enabledModules = useEnabledModules()
	const allModules = getAllWebModules()
	const customExtensions = useCustomExtensions()
	const [pendingRemoval, setPendingRemoval] = useState<PendingRemoval | null>(null)

	const enableModule = (moduleId: string) => {
		const next = [...enabledModules, moduleId]
		let mergedSettings: Record<string, unknown> = { ...settings, enabled_modules: next }

		const mod = getWebModule(moduleId)
		const defaults = mod?.defaultSettings
		if (defaults) {
			const currentDisplayNames = (settings?.display_names as Record<string, string>) ?? {}
			const currentStatuses = (settings?.statuses as Record<string, string[]>) ?? {}
			mergedSettings = {
				...mergedSettings,
				display_names: {
					...defaults.display_names,
					...currentDisplayNames,
				},
				statuses: {
					...defaults.statuses,
					...currentStatuses,
				},
			}
		}

		updateWorkspace.mutate(
			{ settings: mergedSettings },
			{ onError: () => toast.error('Failed to update extensions') },
		)
	}

	const disableModule = (moduleId: string) => {
		const next = enabledModules.filter((m) => m !== moduleId)
		updateWorkspace.mutate(
			{ settings: { ...settings, enabled_modules: next } },
			{ onError: () => toast.error('Failed to update extensions') },
		)
	}

	const handleToggle = (moduleId: string, enabled: boolean) => {
		if (enabled) {
			enableModule(moduleId)
			return
		}
		const mod = getWebModule(moduleId)
		const moduleTypes = mod?.objectTypeTabs.map((t) => t.value) ?? []
		setPendingRemoval({
			affectedTypes: moduleTypes,
			commit: () => disableModule(moduleId),
		})
	}

	const persistCustomExtensionEnabled = (extId: string, enabled: boolean) => {
		const customExts = {
			...((settings?.custom_extensions as Record<string, unknown>) ?? {}),
		}
		const existing = customExts[extId] as Record<string, unknown>
		customExts[extId] = { ...existing, enabled }

		updateWorkspace.mutate(
			{ settings: { ...settings, custom_extensions: customExts } },
			{ onError: () => toast.error('Failed to update extension') },
		)
	}

	const handleToggleCustomExtension = (extId: string, enabled: boolean) => {
		if (enabled) {
			persistCustomExtensionEnabled(extId, true)
			return
		}
		const ext = customExtensions.find((e) => e.id === extId)
		setPendingRemoval({
			affectedTypes: ext?.types ?? [],
			commit: () => persistCustomExtensionEnabled(extId, false),
		})
	}

	const persistDeleteCustomExtension = (extId: string, types: string[]) => {
		const statuses = { ...((settings?.statuses as Record<string, string[]>) ?? {}) }
		const displayNames = { ...((settings?.display_names as Record<string, string>) ?? {}) }
		const fieldDefs = {
			...((settings?.field_definitions as Record<string, unknown[]>) ?? {}),
		}
		const customExts = {
			...((settings?.custom_extensions as Record<string, unknown>) ?? {}),
		}

		for (const type of types) {
			delete statuses[type]
			delete displayNames[type]
			delete fieldDefs[type]
		}
		delete customExts[extId]

		updateWorkspace.mutate(
			{
				settings: {
					...settings,
					statuses,
					display_names: displayNames,
					field_definitions: fieldDefs,
					custom_extensions: customExts,
				},
			},
			{ onError: () => toast.error('Failed to delete extension') },
		)
	}

	const handleDeleteCustomExtension = (extId: string, types: string[]) => {
		setPendingRemoval({
			affectedTypes: types,
			commit: () => persistDeleteCustomExtension(extId, types),
		})
	}

	return (
		<div>
			<Label className="mb-1 text-muted-foreground">Extensions</Label>
			<p className="text-sm text-muted-foreground mb-3">
				Enable or disable extensions for this workspace.
			</p>
			<div className="space-y-3">
				{allModules.map((mod) => {
					const isEnabled = enabledModules.includes(mod.id)
					return (
						<div
							key={mod.id}
							className="flex items-center justify-between rounded-lg border border-border p-3"
						>
							<div>
								<span className="text-sm font-medium">{mod.name}</span>
								{mod.objectTypeTabs.length > 0 && (
									<span className="text-sm text-muted-foreground ml-2">
										{mod.objectTypeTabs.map((t) => t.label).join(', ')}
									</span>
								)}
							</div>
							<Switch
								checked={isEnabled}
								onCheckedChange={(checked) => handleToggle(mod.id, !!checked)}
							/>
						</div>
					)
				})}
				{customExtensions.map((ext) => (
					<div
						key={ext.id}
						className="flex items-center justify-between rounded-lg border border-border p-3"
					>
						<div>
							<span className="text-sm font-medium">{ext.name}</span>
							{ext.tabs.length > 0 && (
								<span className="text-sm text-muted-foreground ml-2">
									{ext.tabs.map((t) => t.label).join(', ')}
								</span>
							)}
						</div>
						<div className="flex items-center gap-3">
							<button
								type="button"
								aria-label={`Delete ${ext.name}`}
								onClick={() => handleDeleteCustomExtension(ext.id, ext.types)}
								className="text-muted-foreground hover:text-destructive transition-colors"
							>
								<Trash2 size={15} />
							</button>
							<Switch
								checked={ext.enabled}
								onCheckedChange={(checked) => handleToggleCustomExtension(ext.id, !!checked)}
							/>
						</div>
					</div>
				))}
			</div>

			{pendingRemoval && (
				<ExtensionRemovalDialog
					open={true}
					onOpenChange={(open) => {
						if (!open) setPendingRemoval(null)
					}}
					affectedTypes={pendingRemoval.affectedTypes}
					workspaceId={workspaceId}
					settings={settings}
					onConfirmed={() => {
						pendingRemoval.commit()
						setPendingRemoval(null)
					}}
				/>
			)}
		</div>
	)
}
