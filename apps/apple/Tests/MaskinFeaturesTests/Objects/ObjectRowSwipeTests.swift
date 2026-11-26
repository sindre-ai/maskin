import Testing

@testable import MaskinFeatures

@Suite("ObjectRowSwipe")
struct ObjectRowSwipeTests {
	@Test("an agent's ask wins the right swipe, whatever else the row could do")
	func askWinsLeading() {
		let swipe = ObjectRowSwipe.leading(hasAsk: true, needsYou: true, canApprove: true, canMarkDone: true)
		#expect(swipe == .approveAsk)
	}

	@Test("a row that needs you and has a next status approves")
	func approveWhenNeedsYou() {
		let swipe = ObjectRowSwipe.leading(hasAsk: false, needsYou: true, canApprove: true, canMarkDone: true)
		#expect(swipe == .approve)
	}

	@Test("a row that needs you but has no next status falls through to Done")
	func needsYouWithoutTarget() {
		let swipe = ObjectRowSwipe.leading(hasAsk: false, needsYou: true, canApprove: false, canMarkDone: true)
		#expect(swipe == .done)
	}

	@Test("a row that does not need you is marked done, never approved")
	func doneWhenNotUrgent() {
		let swipe = ObjectRowSwipe.leading(hasAsk: false, needsYou: false, canApprove: true, canMarkDone: true)
		#expect(swipe == .done)
	}

	@Test("a row already done has no right swipe")
	func nothingToDo() {
		let swipe = ObjectRowSwipe.leading(hasAsk: false, needsYou: false, canApprove: false, canMarkDone: false)
		#expect(swipe == nil)
	}

	@Test("an ask is held on the left swipe, never archived")
	func askIsHeld() {
		#expect(ObjectRowSwipe.trailing(hasAsk: true, canArchive: true) == .hold)
		#expect(ObjectRowSwipe.trailing(hasAsk: true, canArchive: false) == .hold)
	}

	@Test("without an ask the left swipe archives, or deletes when the type cannot be archived")
	func archiveOrDelete() {
		#expect(ObjectRowSwipe.trailing(hasAsk: false, canArchive: true) == .archive)
		#expect(ObjectRowSwipe.trailing(hasAsk: false, canArchive: false) == .delete)
	}
}
