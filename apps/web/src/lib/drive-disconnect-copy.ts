import { type DriveDisconnectScope, joinServices } from '@/lib/drive-disconnect'

/** Copy for the Disconnect Drive modal and the post-disconnect callout, from the
 *  design spec Copy section, Disable modal. Strings marked EDITED differ from the
 *  spec: Drive has its own OAuth client, so nothing here claims a shared grant or
 *  shared scopes (reconciliation 2). The spec's fixed "Gmail, Calendar and Meet stay
 *  connected" sentences are replaced by lists built from the rows that exist. */

export const DRIVE_DISCONNECT_COPY = {
	title: (name: string) => `Disconnect Drive for ${name}?`,
	// EDITED: the spec says "...with Gmail, Calendar, Meet and Drive scopes".
	body: (name: string, connected: readonly string[]) =>
		`${name} currently has Google connected with ${joinServices(connected)}. Choose how much to remove.`,
	options: {
		drive: {
			// EDITED: spec "Just remove Drive scopes".
			label: 'Just disconnect Drive',
			// EDITED: drops the fixed "Gmail, Calendar and Meet stay connected." sentence;
			// the callout below the radios names what stays, from the real rows.
			hint: (name: string) =>
				`Agents can no longer read, write or watch ${name}'s Drive files. ${name} can re-add Drive from this page any time.`,
		},
		'drive-meet': {
			// EDITED: spec "Remove Drive + Meet scopes".
			label: 'Disconnect Drive and Meet',
			// EDITED: drops "ride the same Google OAuth grant" and the fixed "Gmail and
			// Calendar stay." sentence.
			hint: "Disconnects both Drive and Meet, since they are often adopted together. Meet recordings won't be reachable either way.",
			chip: 'common — Meet + Drive ship together',
		},
		google: {
			label: (name: string) => `Disconnect ${name}'s whole Google account`,
			hint: (name: string) =>
				`Removes Gmail, Calendar, Meet and Drive. Agents lose all Google-backed access for ${name} until they reconnect.`,
		},
	},
	// No spec line for the in-modal callout; written for this task.
	stays: (remaining: readonly string[]) =>
		remaining.length > 0
			? `Still connected: ${joinServices(remaining)}.`
			: 'Nothing else stays connected for this Google account.',
	cancel: 'Cancel',
	confirm: {
		drive: 'Disconnect Drive',
		'drive-meet': 'Disconnect Drive + Meet',
		google: 'Disconnect Google account',
	} satisfies Record<DriveDisconnectScope, string>,
	// No spec line for the failure state; written for this task.
	error: 'Could not disconnect. Try again.',
	// The spec line is "Drive disconnected for Kai. Gmail, Calendar and Meet are still
	// connected." The other two scopes and the none-left case have no spec line.
	callout: (scope: DriveDisconnectScope, name: string, remaining: readonly string[]) => {
		const lead =
			scope === 'drive'
				? `Drive disconnected for ${name}.`
				: scope === 'drive-meet'
					? `Drive and Meet disconnected for ${name}.`
					: `Google account disconnected for ${name}.`
		if (remaining.length === 0) return lead
		return `${lead} ${joinServices(remaining)} ${remaining.length === 1 ? 'is' : 'are'} still connected.`
	},
	disconnectCta: 'Disconnect Drive',
} as const
