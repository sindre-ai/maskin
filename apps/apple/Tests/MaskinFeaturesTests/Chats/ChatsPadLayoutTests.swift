import SwiftUI
import Testing

@testable import MaskinFeatures

@Suite("iPad Chats layout")
struct ChatsPadLayoutTests {
	@Test("a window taller than wide is portrait")
	func portrait() {
		#expect(ChatsPadLayout.isPortrait(CGSize(width: 744, height: 1133)))
		#expect(!ChatsPadLayout.isPortrait(CGSize(width: 1133, height: 744)))
		#expect(!ChatsPadLayout.isPortrait(CGSize(width: 800, height: 800)))
	}

	@Test("the list is 360 wide in portrait and 430 in landscape")
	func widths() {
		#expect(ChatsPadLayout.listWidth(portrait: true) == 360)
		#expect(ChatsPadLayout.listWidth(portrait: false) == 430)
	}

	@Test("portrait hides the list once a chat is open and shows it with none")
	func portraitVisibility() {
		#expect(ChatsPadLayout.visibility(portrait: true, hasSelection: true) == .detailOnly)
		#expect(ChatsPadLayout.visibility(portrait: true, hasSelection: false) == .all)
	}

	@Test("landscape always shows the list")
	func landscapeVisibility() {
		#expect(ChatsPadLayout.visibility(portrait: false, hasSelection: true) == .all)
		#expect(ChatsPadLayout.visibility(portrait: false, hasSelection: false) == .all)
	}

	@Test("the panel button flips between list hidden and list shown")
	func toggle() {
		#expect(ChatsPadLayout.toggled(.all) == .detailOnly)
		#expect(ChatsPadLayout.toggled(.detailOnly) == .all)
		#expect(ChatsPadLayout.toggled(.automatic) == .detailOnly)
	}
}
