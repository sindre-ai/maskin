// Snapshot helpers for the custom views (extra tabs on the loop page) a
// marketplace loop can carry. A view is published as one marketplace_loop_items
// row with item_type 'view', holding the tab name, its place in the tab order
// and the page HTML. The install path copies each one into the installer's
// workspace as a new HTML file; it never links to the publisher's file.
//
// The page may hold LOOP_ID_TOKEN wherever it needs the id of the loop object
// the install creates (a data source scope, for example). The install path
// swaps it for the real id, so the checked-in page carries no workspace id.

export const LOOP_ID_TOKEN = '__MASKIN_LOOP_ID__'

export interface ViewSnapshotSource {
	name: string
	position: number
	html: string
}

export function viewSnapshot(row: ViewSnapshotSource): Record<string, unknown> {
	return { name: row.name, position: row.position, html: row.html }
}
