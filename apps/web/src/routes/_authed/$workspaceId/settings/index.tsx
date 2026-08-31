import { LegacyGeneralPage } from '@/components/settings/legacy/general-page'
import { RouteError } from '@/components/shared/route-error'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Separator } from '@/components/ui/separator'
import { Switch } from '@/components/ui/switch'
import { useFeatureFlag } from '@/hooks/use-feature-flag'
import { useUpdateWorkspace } from '@/hooks/use-workspaces'
import { cn } from '@/lib/cn'
import { type Theme, useTheme } from '@/lib/theme'
import { useWorkspace } from '@/lib/workspace-context'
import { createFileRoute } from '@tanstack/react-router'
import { Monitor, Moon, Sun } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'

export const Route = createFileRoute('/_authed/$workspaceId/settings/')({
	component: GeneralPage,
	errorComponent: ({ error }) => <RouteError error={error} />,
})

function GeneralPageV2() {
	const { workspace, workspaceId } = useWorkspace()
	const updateWorkspace = useUpdateWorkspace(workspaceId)
	const [name, setName] = useState(workspace.name)

	const handleSave = () => {
		if (name !== workspace.name) {
			updateWorkspace.mutate(
				{ name },
				{
					onSuccess: () => toast.success('Workspace name saved'),
					onError: () => toast.error('Failed to save the workspace name'),
				},
			)
		}
	}

	return (
		<div className="max-w-[580px]">
			<h2 className="settings-label mb-[7px]">WORKSPACE NAME</h2>
			<div className="flex gap-2">
				<Input
					type="text"
					value={name}
					onChange={(e) => setName(e.target.value)}
					aria-label="Workspace name"
					className="flex-1"
				/>
				<Button
					onClick={handleSave}
					disabled={name === workspace.name || updateWorkspace.isPending}
				>
					Save
				</Button>
			</div>

			<Separator className="my-6" />
			<ThemePicker />

			<Separator className="my-6" />
			<PrivacySection />
		</div>
	)
}

interface PrivacySettings {
	share_usage: boolean
	anonymize_workspace: boolean
}

function readPrivacySettings(settings: Record<string, unknown>): PrivacySettings {
	const raw = (settings.privacy ?? {}) as Partial<PrivacySettings>
	return {
		share_usage: raw.share_usage ?? true,
		anonymize_workspace: raw.anonymize_workspace ?? false,
	}
}

function PrivacySection() {
	const { workspace, workspaceId } = useWorkspace()
	const updateWorkspace = useUpdateWorkspace(workspaceId)
	const settings = workspace.settings as Record<string, unknown>
	const privacy = readPrivacySettings(settings)

	const persist = (next: PrivacySettings) => {
		updateWorkspace.mutate(
			{ settings: { ...settings, privacy: next } },
			{ onError: () => toast.error('Failed to update privacy settings') },
		)
	}

	return (
		<div>
			<h2 className="settings-label mb-1.5">PRIVACY &amp; DATA</h2>
			<p className="mb-3 max-w-prose text-xs leading-relaxed text-muted-foreground">
				Usage events feed the Synthesizer so the team sees how the workspace is really used. No
				object titles, no content, no PII.
			</p>
			<div className="space-y-2.5">
				<div className="flex items-start justify-between gap-4 rounded-xl border border-border bg-card p-3">
					<div className="min-w-0">
						<span className="block text-[12.5px] font-semibold">
							Share product usage with Maskin
						</span>
						<span className="text-xs text-muted-foreground">
							Bet lifecycle, agent sessions, trigger fires. No content, no PII.
						</span>
					</div>
					<Switch
						checked={privacy.share_usage}
						onCheckedChange={(checked) => persist({ ...privacy, share_usage: !!checked })}
						aria-label="Share product usage with Maskin"
					/>
				</div>
				<div className="flex items-start justify-between gap-4 rounded-xl border border-border bg-card p-3">
					<div className="min-w-0">
						<span className="block text-[12.5px] font-semibold">Anonymize this workspace</span>
						<span className="text-xs text-muted-foreground">
							Rotate workspace and actor IDs into hashes before events leave the browser.
						</span>
					</div>
					<Switch
						checked={privacy.anonymize_workspace}
						onCheckedChange={(checked) => persist({ ...privacy, anonymize_workspace: !!checked })}
						aria-label="Anonymize this workspace"
					/>
				</div>
			</div>
		</div>
	)
}

const themeOptions: { value: Theme; label: string; icon: typeof Sun }[] = [
	{ value: 'light', label: 'Light', icon: Sun },
	{ value: 'dark', label: 'Dark', icon: Moon },
	{ value: 'system', label: 'System', icon: Monitor },
]

function ThemePicker() {
	const { theme, setTheme } = useTheme()

	return (
		<div>
			<h2 className="settings-label mb-2.5">APPEARANCE</h2>
			<div className="flex w-full gap-1 rounded-xl border border-border bg-card p-1 sm:inline-flex sm:w-auto">
				{themeOptions.map((option) => {
					const Icon = option.icon
					const isActive = theme === option.value
					return (
						<button
							key={option.value}
							type="button"
							onClick={() => setTheme(option.value)}
							className={cn(
								'flex flex-1 items-center justify-center gap-1.5 rounded-lg px-4 py-1.5 text-[12.5px] font-semibold transition-colors sm:flex-none',
								isActive
									? 'bg-primary text-primary-foreground'
									: 'text-muted-foreground hover:text-foreground',
							)}
						>
							<Icon size={14} />
							{option.label}
						</button>
					)
				})}
			</div>
		</div>
	)
}

// `new-design` boundary for Settings → General.
function GeneralPage() {
	return useFeatureFlag('new-design') ? <GeneralPageV2 /> : <LegacyGeneralPage />
}
