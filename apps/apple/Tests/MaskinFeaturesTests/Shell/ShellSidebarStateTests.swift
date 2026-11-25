import MaskinCore
import Testing

@testable import MaskinFeatures

@Suite("ShellSidebarState")
struct ShellSidebarStateTests {
	@Test("with no chat open the sidebar is 264 pt wide, with labels")
	func openByDefault() {
		let state = ShellSidebarState()
		#expect(state.isExpanded)
		#expect(state.width == 264)
	}

	@Test("opening a chat folds the sidebar to 72 pt")
	func chatFolds() {
		var state = ShellSidebarState()
		state.setChatOpen(true)
		#expect(!state.isExpanded)
		#expect(state.width == 72)
	}

	@Test("opening the sidebar by hand keeps it open until the chat closes")
	func manualExpandStaysWhileChatOpen() {
		var state = ShellSidebarState()
		state.setChatOpen(true)
		state.toggle()
		#expect(state.isExpanded)
		// Another chat opening (the flag stays true) does not fold it again.
		state.setChatOpen(true)
		#expect(state.isExpanded)
	}

	@Test("leaving the chat restores the state from before it")
	func restoresOpen() {
		var state = ShellSidebarState()
		state.setChatOpen(true)
		state.toggle()
		state.setChatOpen(false)
		#expect(state.isExpanded)
		#expect(state.width == 264)
	}

	@Test("a sidebar folded by hand stays folded after a chat comes and goes")
	func restoresFolded() {
		var state = ShellSidebarState()
		state.toggle()
		#expect(!state.isExpanded)
		state.setChatOpen(true)
		#expect(!state.isExpanded)
		state.toggle()
		#expect(state.isExpanded)
		state.setChatOpen(false)
		#expect(!state.isExpanded)
	}

	@Test("the next chat starts folded again")
	func nextChatFolds() {
		var state = ShellSidebarState()
		state.setChatOpen(true)
		state.toggle()
		state.setChatOpen(false)
		state.setChatOpen(true)
		#expect(!state.isExpanded)
	}

	@Test("the collapse button folds it while a chat is open")
	func collapseWhileChatOpen() {
		var state = ShellSidebarState()
		state.setChatOpen(true)
		state.toggle()
		state.toggle()
		#expect(!state.isExpanded)
	}

	@Test("a folded sidebar shows any badge as a dot")
	func badgesBecomeDots() {
		#expect(TabBadge.none.asDot == .none)
		#expect(TabBadge.count(3).asDot == .dot)
		#expect(TabBadge.dot.asDot == .dot)
	}
}

@Suite("StoryRow fade")
struct StoryRowFadeTests {
	@Test("the fade shows while the row can scroll further right")
	func showsWithMore() {
		#expect(StoryRow.hasMore(offset: 0, visible: 600, content: 900))
		#expect(StoryRow.hasMore(offset: 200, visible: 600, content: 900))
	}

	@Test("the fade goes at the end of the scroll")
	func goesAtEnd() {
		#expect(!StoryRow.hasMore(offset: 300, visible: 600, content: 900))
		#expect(!StoryRow.hasMore(offset: 0, visible: 600, content: 500))
	}

	@Test("the fade is 36 pt")
	func width() {
		#expect(StoryRow.fadeWidth == 36)
	}
}
