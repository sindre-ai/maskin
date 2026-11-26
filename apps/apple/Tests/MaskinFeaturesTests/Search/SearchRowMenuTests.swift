import MaskinCore
import Testing

@testable import MaskinFeatures

@Suite("SearchRowMenu")
struct SearchRowMenuTests {
	private func chatMenu(pinned: Bool = false, unread: Bool = false) -> TeamRowActions {
		SearchRowMenu.chatActions(
			isPinned: pinned, isUnread: unread, pin: {}, toggleRead: {}, archive: {}, delete: {})
	}

	@Test("a chat result with its row loaded gets the chat list's menu")
	func chatResult() {
		#expect(SearchRowMenu.of(.chat, rowLoaded: true) == .chat)
	}

	@Test("an object result with its row loaded gets the objects list's menu")
	func objectResult() {
		#expect(SearchRowMenu.of(.object, rowLoaded: true) == .object)
	}

	@Test("a chat or object result whose row has not arrived yet gets no menu")
	func rowNotLoaded() {
		#expect(SearchRowMenu.of(.chat, rowLoaded: false) == .none)
		#expect(SearchRowMenu.of(.object, rowLoaded: false) == .none)
	}

	@Test("agents and files never get a menu, loaded or not")
	func agentsAndFiles() {
		for kind in [SearchKind.agent, .file] {
			#expect(SearchRowMenu.of(kind, rowLoaded: true) == .none)
			#expect(SearchRowMenu.of(kind, rowLoaded: false) == .none)
		}
	}

	@Test("every result kind is decided here: a new kind has to pick a menu")
	func everyKindCovered() {
		let withMenu = SearchKind.allCases.filter { SearchRowMenu.of($0, rowLoaded: true) != .none }
		#expect(Set(withMenu) == [.chat, .object])
	}

	@Test("the chat menu offers Pin, Read, Archive and Delete, with Delete last")
	func chatMenuItems() {
		#expect(chatMenu().menuItems == [.pin, .toggleRead, .archive, .delete])
	}

	@Test("the chat menu has no Select and no reordering, search has no bulk mode")
	func chatMenuLeavesOut() {
		let items = chatMenu(pinned: true).menuItems
		#expect(!items.contains(.select))
		#expect(!items.contains(.moveEarlier))
		#expect(!items.contains(.moveLater))
	}

	@Test("the chat menu says what Pin and Read do for the chat's current state")
	func chatMenuLabels() {
		#expect(chatMenu(pinned: true, unread: true).pinMenuLabel == "Unpin")
		#expect(chatMenu(pinned: true, unread: true).readMenuLabel == "Mark as read")
		#expect(chatMenu(pinned: false, unread: false).pinMenuLabel == "Pin to top")
		#expect(chatMenu(pinned: false, unread: false).readMenuLabel == "Mark as unread")
	}
}
