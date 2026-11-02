import MaskinCore
import MaskinDesign
import SwiftUI

/// What a Team row can do, and its current state, so the swipe actions, the long-press menu and
/// the "More" dialog all read from one place (spec 7 §6).
struct TeamRowActions {
	var isPinned: Bool
	var isUnread: Bool
	/// Flows have no unread state in the API yet, so Read/Unread is left out for them.
	var canToggleRead = true
	var canArchive = true
	var canDelete = true
	var pin: () -> Void
	var toggleRead: () -> Void
	var archive: () -> Void
	var delete: () -> Void
	/// Opens the row menu (the "More" swipe action).
	var more: () -> Void
	/// Enters selection mode with this row picked (the list's bulk actions). Nil hides it.
	var select: (() -> Void)? = nil

	var pinLabel: String { isPinned ? "Unpin" : "Pin" }
	var readLabel: String { isUnread ? "Read" : "Unread" }
	var readMenuLabel: String { isUnread ? "Mark as read" : "Mark as unread" }
}

extension View {
	/// Swipe left: Pin/Unpin (`fg4`), More (grey; opens the row menu) and Archive (ink). Swipe
	/// right: Read/Unread (`sig`), a full swipe toggles it. Long-press (or right-click) shows the
	/// same menu as "More".
	func teamRowActions(_ actions: TeamRowActions, enabled: Bool = true) -> some View {
		modifier(TeamRowActionsModifier(actions: actions, enabled: enabled))
	}
}

private struct TeamRowActionsModifier: ViewModifier {
	let actions: TeamRowActions
	/// Off in selection mode: a swipe or long-press would fight the checkboxes.
	var enabled = true

	func body(content: Content) -> some View {
		content
			.swipeActions(edge: .leading, allowsFullSwipe: true) {
				if enabled, actions.canToggleRead {
					Button {
						MaskinHaptics.play(.selection)
						actions.toggleRead()
					} label: {
						Label(actions.readLabel, systemImage: actions.isUnread ? "envelope.open" : "envelope.badge")
					}
					.tint(MaskinColor.sig)
				}
			}
			.swipeActions(edge: .trailing, allowsFullSwipe: false) {
				if !enabled {
					EmptyView()
				} else {
				if actions.canArchive {
					Button {
						MaskinHaptics.play(.selection)
						actions.archive()
					} label: {
						Label("Archive", systemImage: "archivebox")
					}
					.tint(MaskinSurface.inverse)
				}
				Button(action: actions.more) {
					Label("More", systemImage: "ellipsis")
				}
				// Spec says `line3`; a swipe button's label is always white, so the grey is one step
				// darker to stay legible.
				.tint(MaskinColor.ink3)
				Button {
					MaskinHaptics.play(.selection)
					actions.pin()
				} label: {
					Label(actions.pinLabel, systemImage: actions.isPinned ? "pin.slash" : "pin")
				}
				.tint(MaskinColor.ink4)
				}
			}
			.contextMenu { if enabled { TeamRowMenuItems(actions: actions) } }
	}
}

/// The row menu's items: Pin/Unpin · Mark as read/unread · Archive · Delete (red).
struct TeamRowMenuItems: View {
	let actions: TeamRowActions

	var body: some View {
		Button(actions.pinLabel, systemImage: actions.isPinned ? "pin.slash" : "pin", action: actions.pin)
		if actions.canToggleRead {
			Button(
				actions.readMenuLabel, systemImage: actions.isUnread ? "envelope.open" : "envelope.badge",
				action: actions.toggleRead)
		}
		if actions.canArchive {
			Button("Archive", systemImage: "archivebox", action: actions.archive)
		}
		if let select = actions.select {
			Button("Select", systemImage: "checkmark.circle", action: select)
		}
		if actions.canDelete {
			Button("Delete", systemImage: "trash", role: .destructive, action: actions.delete)
		}
	}
}

/// The "More" swipe action's menu, as a dialog on the row it was opened for.
struct TeamRowMenuDialog: ViewModifier {
	@Binding var target: TeamRowMenuTarget?

	func body(content: Content) -> some View {
		content.confirmationDialog(
			target?.title ?? "", isPresented: Binding(get: { target != nil }, set: { if !$0 { target = nil } }),
			titleVisibility: .visible, presenting: target
		) { target in
			TeamRowMenuItems(actions: target.actions)
		}
	}
}

struct TeamRowMenuTarget: Identifiable {
	var id: String
	var title: String
	var actions: TeamRowActions
}

extension View {
	func teamRowMenu(_ target: Binding<TeamRowMenuTarget?>) -> some View {
		modifier(TeamRowMenuDialog(target: target))
	}
}
