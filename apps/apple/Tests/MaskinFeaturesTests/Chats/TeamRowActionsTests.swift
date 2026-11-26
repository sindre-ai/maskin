import Testing

@testable import MaskinFeatures

@Suite("TeamRowActions")
struct TeamRowActionsTests {
	private func row(
		pinned: Bool = false, unread: Bool = false, canToggleRead: Bool = true, canArchive: Bool = true,
		canDelete: Bool = true
	) -> TeamRowActions {
		TeamRowActions(
			isPinned: pinned, isUnread: unread, canToggleRead: canToggleRead, canArchive: canArchive,
			canDelete: canDelete, pin: {}, toggleRead: {}, archive: {}, delete: {}, more: {})
	}

	@Test("a chat's menu offers Pin, Read, Archive and Delete, with Delete last")
	func chatMenu() {
		#expect(row().menuItems == [.pin, .toggleRead, .archive, .delete])
	}

	@Test("a flow room's menu offers Pin only: no read state, no archive, no delete")
	func flowMenu() {
		let flow = row(canToggleRead: false, canArchive: false, canDelete: false)
		#expect(flow.menuItems == [.pin])
	}

	@Test("Select joins the menu, before Delete, only when selection can start")
	func selectItem() {
		var actions = row()
		#expect(!actions.menuItems.contains(.select))
		actions.select = {}
		#expect(actions.menuItems == [.pin, .toggleRead, .archive, .select, .delete])
	}

	@Test("a pinned tile with neighbours on both sides can move earlier and later, after Read")
	func pinnedMiddleTile() {
		var actions = row(pinned: true)
		actions.moveEarlier = {}
		actions.moveLater = {}
		#expect(actions.menuItems == [.pin, .toggleRead, .moveEarlier, .moveLater, .archive, .delete])
	}

	@Test("the first pinned tile can only move later, the last only earlier")
	func pinnedEdges() {
		var first = row(pinned: true)
		first.moveLater = {}
		#expect(first.menuItems.contains(.moveLater))
		#expect(!first.menuItems.contains(.moveEarlier))
		var last = row(pinned: true)
		last.moveEarlier = {}
		#expect(last.menuItems.contains(.moveEarlier))
		#expect(!last.menuItems.contains(.moveLater))
	}

	@Test("the right swipe is Read/Unread for a chat and nothing for a flow room")
	func leadingSwipe() {
		#expect(row().leadingSwipeItems == [.toggleRead])
		#expect(row(canToggleRead: false).leadingSwipeItems.isEmpty)
	}

	@Test("the left swipe is Archive, More, Pin; a flow room has no Archive")
	func trailingSwipe() {
		#expect(row().trailingSwipeItems == [.archive, .more, .pin])
		#expect(row(canArchive: false).trailingSwipeItems == [.more, .pin])
	}

	@Test("Pin says what it does: the swipe is short, the menu is plain")
	func pinLabels() {
		#expect(row(pinned: false).pinLabel == "Pin")
		#expect(row(pinned: false).pinMenuLabel == "Pin to top")
		#expect(row(pinned: true).pinLabel == "Unpin")
		#expect(row(pinned: true).pinMenuLabel == "Unpin")
	}

	@Test("Read and Unread name the change, not the state")
	func readLabels() {
		#expect(row(unread: true).readLabel == "Read")
		#expect(row(unread: true).readMenuLabel == "Mark as read")
		#expect(row(unread: false).readLabel == "Unread")
		#expect(row(unread: false).readMenuLabel == "Mark as unread")
	}
}
