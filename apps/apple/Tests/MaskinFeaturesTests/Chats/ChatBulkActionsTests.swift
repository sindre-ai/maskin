import MaskinCore
import Testing

@testable import MaskinFeatures

@Suite("ChatBulkActions")
struct ChatBulkActionsTests {
	@Test("the More menu offers Pin, Unpin, Mark as read and Mark as unread, in that order")
	func moreMenu() {
		let bulk = ChatBulkActions(ids: ["a", "b"])
		#expect(bulk.moreItems == [.pin, .unpin, .markRead, .markUnread])
		#expect(bulk.moreItems.map(\.title) == ["Pin", "Unpin", "Mark as read", "Mark as unread"])
	}

	@Test("Archive is the primary button and is not in the More menu")
	func archiveIsPrimary() {
		let bulk = ChatBulkActions(ids: ["a"])
		#expect(bulk.primary == .archive)
		#expect(bulk.primary.title == "Archive")
		#expect(!bulk.moreItems.contains(.archive))
	}

	@Test("the menu is the same for one chat or many")
	func sameForAnySelection() {
		#expect(ChatBulkActions(ids: ["a"]).moreItems == ChatBulkActions(ids: ["a", "b", "c"]).moreItems)
	}

	@Test("nothing picked dims the menu and Archive; one pick turns them on")
	func enabledNeedsAPick() {
		#expect(!ChatBulkActions(ids: []).isEnabled)
		#expect(ChatBulkActions(ids: ["a"]).isEnabled)
	}

	@Test("every item has an icon, and the icons are all different")
	func icons() {
		let all: [ChatBulkActions.Item] = [.pin, .unpin, .markRead, .markUnread, .archive]
		#expect(Set(all.map(\.systemImage)).count == all.count)
	}

	@Test("an archive that landed offers Undo with the count that archived")
	func undoOffer() {
		let undo = ChatBulkActions.archiveUndo(ids: ["a", "b"], result: BulkResult(succeeded: 2, failed: 0))
		#expect(undo?.message == "Archived 2. Undo.")
		#expect(undo?.idsToRestore == ["a", "b"])
	}

	@Test("a partial archive counts only what archived, but Undo covers every chat that was sent")
	func undoAfterPartialArchive() {
		let undo = ChatBulkActions.archiveUndo(ids: ["a", "b", "c"], result: BulkResult(succeeded: 1, failed: 2))
		#expect(undo?.message == "Archived 1. Undo.")
		#expect(undo?.idsToRestore == ["a", "b", "c"])
	}

	@Test("an archive where every write failed offers no Undo")
	func noUndoWhenNothingArchived() {
		#expect(ChatBulkActions.archiveUndo(ids: ["a", "b"], result: BulkResult(succeeded: 0, failed: 2)) == nil)
		#expect(ChatBulkActions.archiveUndo(ids: [], result: BulkResult()) == nil)
	}

	@Test("Undo keeps the order the chats were picked in")
	func undoKeepsOrder() {
		let undo = ChatBulkActions.archiveUndo(ids: ["c", "a", "b"], result: BulkResult(succeeded: 3, failed: 0))
		#expect(undo?.idsToRestore == ["c", "a", "b"])
	}
}
