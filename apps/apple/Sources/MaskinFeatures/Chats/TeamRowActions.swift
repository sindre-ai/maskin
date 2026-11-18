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
	/// Reorder within PINNED; set only for a pinned tile that has a neighbour on that side.
	var moveEarlier: (() -> Void)? = nil
	var moveLater: (() -> Void)? = nil

	var pinLabel: String { isPinned ? "Unpin" : "Pin" }
	/// The row menu says what Pin does; the swipe button has no room for it.
	var pinMenuLabel: String { isPinned ? "Unpin" : "Pin to top" }
	var readLabel: String { isUnread ? "Read" : "Unread" }
	var readMenuLabel: String { isUnread ? "Mark as read" : "Mark as unread" }

	/// One button a row can offer, on a swipe or in the menu.
	enum Item: Hashable {
		case pin, toggleRead, moveEarlier, moveLater, archive, select, delete, more
	}

	/// Swipe right: Read/Unread, for rows that have an unread state.
	var leadingSwipeItems: [Item] { canToggleRead ? [.toggleRead] : [] }

	/// Swipe left, in the order shown: Archive, More, Pin.
	var trailingSwipeItems: [Item] { (canArchive ? [.archive] : []) + [.more, .pin] }

	/// The long-press menu and the "More" dialog, in the order shown. Delete is always last.
	var menuItems: [Item] {
		var items: [Item] = [.pin]
		if canToggleRead { items.append(.toggleRead) }
		if moveEarlier != nil { items.append(.moveEarlier) }
		if moveLater != nil { items.append(.moveLater) }
		if canArchive { items.append(.archive) }
		if select != nil { items.append(.select) }
		if canDelete { items.append(.delete) }
		return items
	}
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
				if enabled {
					ForEach(actions.leadingSwipeItems, id: \.self) { swipeButton($0) }
				}
			}
			.swipeActions(edge: .trailing, allowsFullSwipe: false) {
				if enabled {
					ForEach(actions.trailingSwipeItems, id: \.self) { swipeButton($0) }
				}
			}
			.contextMenu { if enabled { TeamRowMenuItems(actions: actions) } }
	}

	@ViewBuilder
	private func swipeButton(_ item: TeamRowActions.Item) -> some View {
		switch item {
		case .toggleRead:
			Button {
				MaskinHaptics.play(.selection)
				actions.toggleRead()
			} label: {
				Label(actions.readLabel, systemImage: actions.isUnread ? "envelope.open" : "envelope.badge")
			}
			.tint(MaskinColor.sig)
		case .archive:
			Button {
				MaskinHaptics.play(.selection)
				actions.archive()
			} label: {
				Label("Archive", systemImage: "archivebox")
			}
			.tint(MaskinSurface.inverse)
		case .more:
			Button(action: actions.more) {
				Label("More", systemImage: "ellipsis")
			}
			// Spec says `line3`; a swipe button's label is always white, so the grey is one step
			// darker to stay legible.
			.tint(MaskinColor.ink3)
		case .pin:
			Button {
				MaskinHaptics.play(.selection)
				actions.pin()
			} label: {
				Label(actions.pinLabel, systemImage: actions.isPinned ? "pin.slash" : "pin")
			}
			.tint(MaskinColor.ink4)
		case .moveEarlier, .moveLater, .select, .delete:
			EmptyView()
		}
	}
}

/// The row menu's items: Pin/Unpin · Mark as read/unread · Archive · Delete (red).
struct TeamRowMenuItems: View {
	let actions: TeamRowActions

	var body: some View {
		ForEach(actions.menuItems, id: \.self) { item in
			switch item {
			case .pin:
				Button(actions.pinMenuLabel, systemImage: actions.isPinned ? "pin.slash" : "pin", action: actions.pin)
			case .toggleRead:
				Button(
					actions.readMenuLabel, systemImage: actions.isUnread ? "envelope.open" : "envelope.badge",
					action: actions.toggleRead)
			case .moveEarlier:
				if let earlier = actions.moveEarlier {
					Button("Move earlier", systemImage: "arrow.up", action: earlier)
				}
			case .moveLater:
				if let later = actions.moveLater {
					Button("Move later", systemImage: "arrow.down", action: later)
				}
			case .archive:
				Button("Archive", systemImage: "archivebox", action: actions.archive)
			case .select:
				if let select = actions.select {
					Button("Select", systemImage: "checkmark.circle", action: select)
				}
			case .delete:
				Button("Delete", systemImage: "trash", role: .destructive, action: actions.delete)
			case .more:
				EmptyView()
			}
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
