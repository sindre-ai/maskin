import { useNewDesign } from '@/lib/new-design-context'
import { CreatePicker as CreatePickerV2 } from './create-picker.v2'
import { CreatePicker as LegacyCreatePicker } from './legacy/create-picker'

// `isCreateShortcut` and `CreatableType` are identical in both branches — the
// shortcut is keyboard plumbing, not visual layer, so it is not flagged.
export { isCreateShortcut, type CreatableType } from './create-picker.v2'

/**
 * The `new-design` boundary for the create overlay.
 *
 * The overlay is opened by route pages (Objects, Agents, Loops, Triggers) and
 * by both shells, so it cannot be swapped at the shell boundary in
 * `routes/_authed/$workspaceId.tsx` the way the sidebar and header are. The
 * flag still travels from that one boundary via `NewDesignProvider`.
 *
 * v2 hands a typed description to a real agent, which structures it into an
 * object; the pre-v2 overlay created the object directly from a title. Both
 * take the same props, so no call site changes.
 */
export function CreatePicker(props: React.ComponentProps<typeof CreatePickerV2>) {
	const newDesign = useNewDesign()
	return newDesign ? <CreatePickerV2 {...props} /> : <LegacyCreatePicker {...props} />
}
