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

	@Test("the list is 300 wide in portrait and 430 in landscape")
	func widths() {
		#expect(ChatsPadLayout.listWidth(portrait: true) == 300)
		#expect(ChatsPadLayout.listWidth(portrait: false) == 430)
	}

	@Test("at regular width the list always shows, with a chat open or not, in either shape")
	func regularVisibility() {
		for portrait in [true, false] {
			for hasSelection in [true, false] {
				#expect(
					ChatsPadLayout.visibility(portrait: portrait, hasSelection: hasSelection, regularWidth: true) == .all)
			}
		}
	}

	@Test("a narrow window keeps today's behaviour: portrait hides the list once a chat is open")
	func narrowVisibility() {
		#expect(ChatsPadLayout.visibility(portrait: true, hasSelection: true, regularWidth: false) == .detailOnly)
		#expect(ChatsPadLayout.visibility(portrait: true, hasSelection: false, regularWidth: false) == .all)
		#expect(ChatsPadLayout.visibility(portrait: false, hasSelection: true, regularWidth: false) == .all)
	}
}

@Suite("Where the account avatar shows")
struct ShellAvatarPlacementTests {
	@Test("with no rail the screen always draws the avatar")
	func noRail() {
		#expect(ShellIdiom.barShowsAvatar(hasRail: false, bottomBar: true))
		#expect(ShellIdiom.barShowsAvatar(hasRail: false, bottomBar: false))
	}

	@Test("with a rail the screen draws it only where the bottom bar is used")
	func rail() {
		#expect(ShellIdiom.barShowsAvatar(hasRail: true, bottomBar: true))
		#expect(!ShellIdiom.barShowsAvatar(hasRail: true, bottomBar: false))
	}

	@Test("Slide Over and a one-third split are portrait but compact: no bottom bar, so no screen avatar")
	func narrowWindow() {
		let bottomBar = PadBarLayout.usesBottomBar(portrait: true, regularWidth: false)
		#expect(!ShellIdiom.barShowsAvatar(hasRail: true, bottomBar: bottomBar))
	}
}
