import { QueryState } from '@/components/shared/query-state'
import { ViewerTooltip } from '@/components/shared/viewer-tooltip'
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from '@/components/ui/select'
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from '@/components/ui/table'
import { useCanWrite } from '@/hooks/use-can-write'
import { useSendPermissions, useSetSendPermission } from '@/hooks/use-send-permissions'
import type { SendPermissionSetting } from '@/lib/api'
import { getStoredActor } from '@/lib/auth'
import { useWorkspace } from '@/lib/workspace-context'
import {
	SEND_PERMISSION_KIND_LABELS,
	SEND_PERMISSION_MODES,
	SEND_PERMISSION_MODE_LABELS,
	type SendPermissionKind,
	type SendPermissionMode,
} from '@maskin/shared'

/** The value of an agent cell that has no setting of its own and follows the workspace default. */
const FOLLOW_DEFAULT = 'default'

/** Only a human admin or owner can change a setting; the server refuses everyone else. */
function useCanChange(): boolean {
	const { workspace } = useWorkspace()
	const canWrite = useCanWrite()
	const me = getStoredActor()
	return (
		canWrite && me?.type === 'human' && (workspace.role === 'owner' || workspace.role === 'admin')
	)
}

const CHANGE_MESSAGE = 'Only a workspace admin or owner can change send permissions'

/**
 * Settings → Send permissions. For each draft kind an agent can send, one of three settings:
 * Always allow (the agent sends without asking and the send is logged on the draft), Ask first
 * (nothing goes out until a person approves the exact text) or Deny (the send tool refuses).
 * The top row is the workspace default; an agent's own setting beats it.
 */
export function SendPermissionsSection({ workspaceId }: { workspaceId: string }) {
	const query = useSendPermissions(workspaceId)
	const setting = useSetSendPermission(workspaceId)
	const canChange = useCanChange()

	return (
		<section aria-labelledby="send-permissions-heading" className="flex flex-col gap-3">
			<div className="flex flex-col gap-1">
				<h2 id="send-permissions-heading" className="text-sm font-semibold text-foreground">
					Send permissions
				</h2>
				<p className="text-xs text-muted-foreground">
					What each agent may send in your name or the company's. Always allow: sends without
					asking, and the draft shows it was sent by the agent. Ask first: nothing goes out until
					you approve the exact text. Deny: the agent cannot send it at all. An agent's own setting
					beats the workspace default. A change applies to the next send.
				</p>
				{!canChange && <p className="text-xs text-muted-foreground">{CHANGE_MESSAGE}.</p>}
			</div>
			<QueryState query={query} isEmpty={() => false} errorTitle="Couldn't load send permissions">
				{(view) => (
					<div className="rounded-xl border border-border bg-card">
						<Table>
							<TableHeader>
								<TableRow>
									<TableHead className="min-w-40">Agent</TableHead>
									{view.kinds.map((kind) => (
										<TableHead key={kind} className="min-w-44">
											{SEND_PERMISSION_KIND_LABELS[kind]}
										</TableHead>
									))}
								</TableRow>
							</TableHeader>
							<TableBody>
								<TableRow>
									<TableCell className="font-medium text-foreground">Workspace default</TableCell>
									{view.kinds.map((kind) => (
										<TableCell key={kind}>
											<ModeSelect
												label={`Workspace default for ${SEND_PERMISSION_KIND_LABELS[kind]}`}
												value={view.workspace_default[kind].mode}
												disabled={!canChange || setting.isPending}
												onChange={(mode) => setting.mutate({ agent_id: null, kind, mode })}
											/>
										</TableCell>
									))}
								</TableRow>
								{view.agents.map((agent) => (
									<TableRow key={agent.agent_id}>
										<TableCell className="font-medium text-foreground">{agent.name}</TableCell>
										{view.kinds.map((kind) => (
											<TableCell key={kind}>
												<AgentCell
													agentName={agent.name}
													kind={kind}
													effective={agent.settings[kind]}
													defaultMode={view.workspace_default[kind].mode}
													disabled={!canChange || setting.isPending}
													onChange={(mode) =>
														setting.mutate({ agent_id: agent.agent_id, kind, mode })
													}
												/>
											</TableCell>
										))}
									</TableRow>
								))}
							</TableBody>
						</Table>
					</div>
				)}
			</QueryState>
		</section>
	)
}

function AgentCell({
	agentName,
	kind,
	effective,
	defaultMode,
	disabled,
	onChange,
}: {
	agentName: string
	kind: SendPermissionKind
	effective: SendPermissionSetting
	defaultMode: SendPermissionMode
	disabled: boolean
	/** null puts the agent back on the workspace default. */
	onChange: (mode: SendPermissionMode | null) => void
}) {
	return (
		<ModeSelect
			label={`${SEND_PERMISSION_KIND_LABELS[kind]} for ${agentName}`}
			value={effective.source === 'agent' ? effective.mode : FOLLOW_DEFAULT}
			followDefaultLabel={`Default (${SEND_PERMISSION_MODE_LABELS[defaultMode]})`}
			disabled={disabled}
			onChange={onChange}
		/>
	)
}

function ModeSelect({
	label,
	value,
	followDefaultLabel,
	disabled,
	onChange,
}: {
	label: string
	value: SendPermissionMode | typeof FOLLOW_DEFAULT
	/** Set on an agent cell: the choice that removes the agent's own setting. */
	followDefaultLabel?: string
	disabled: boolean
	onChange: (mode: SendPermissionMode | null) => void
}) {
	return (
		<ViewerTooltip className="flex w-full">
			<Select
				value={value}
				onValueChange={(next) =>
					onChange(next === FOLLOW_DEFAULT ? null : (next as SendPermissionMode))
				}
				disabled={disabled}
			>
				<SelectTrigger aria-label={label} className="w-full">
					<SelectValue />
				</SelectTrigger>
				<SelectContent>
					{followDefaultLabel && (
						<SelectItem value={FOLLOW_DEFAULT}>{followDefaultLabel}</SelectItem>
					)}
					{SEND_PERMISSION_MODES.map((mode) => (
						<SelectItem key={mode} value={mode}>
							{SEND_PERMISSION_MODE_LABELS[mode]}
						</SelectItem>
					))}
				</SelectContent>
			</Select>
		</ViewerTooltip>
	)
}
