import MaskinCore
import Testing

@testable import MaskinFeatures

@Suite("iPad bottom bar")
struct PadBarLayoutTests {
	@Test("portrait at regular width draws the bar; landscape and narrow windows keep the rail")
	func usesBottomBar() {
		#expect(PadBarLayout.usesBottomBar(portrait: true, regularWidth: true))
		#expect(!PadBarLayout.usesBottomBar(portrait: false, regularWidth: true))
		#expect(!PadBarLayout.usesBottomBar(portrait: true, regularWidth: false))
		#expect(!PadBarLayout.usesBottomBar(portrait: false, regularWidth: false))
	}

	@Test("with no chat open the bar is full on every tab")
	func fullWithNoChat() {
		for tab in ShellTab.primary {
			#expect(PadBarLayout.shape(tab: tab, chatOpen: false, covered: false) == .full)
		}
	}

	@Test("with a chat open on Chats the bar is compact")
	func compactWithChat() {
		#expect(PadBarLayout.shape(tab: .chats, chatOpen: true, covered: false) == .compact)
	}

	@Test("a chat left open behind another tab does not shrink that tab's bar")
	func otherTabIsFull() {
		#expect(PadBarLayout.shape(tab: .forYou, chatOpen: true, covered: false) == .full)
		#expect(PadBarLayout.shape(tab: .loops, chatOpen: true, covered: false) == .full)
		#expect(PadBarLayout.shape(tab: .objects, chatOpen: true, covered: false) == .full)
	}

	@Test("a detail screen, the New conversation form or a sheet hides the bar in either shape")
	func coveredHides() {
		#expect(PadBarLayout.shape(tab: .chats, chatOpen: true, covered: true) == .hidden)
		#expect(PadBarLayout.shape(tab: .forYou, chatOpen: false, covered: true) == .hidden)
	}

	@Test("the compact bar sits under the 300 pt list column")
	func compactColumn() {
		#expect(PadBarLayout.compactColumnWidth == 300)
		#expect(PadBarLayout.compactHeight == 60)
		#expect(PadBarLayout.compactTarget == 48)
		#expect(PadBarLayout.bottomGap == 22)
	}
}
