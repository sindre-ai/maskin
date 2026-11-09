import XCTest

/// MUST-KEEP features of the iPhone app: things a person does that must keep working through any
/// redesign. The list lives in `docs/must-keep-features.md`; every test here is named `testMK<nn>_…`
/// after its row there.
///
/// Rules for this file:
/// - A step that cannot be reached is a FAILURE, never a skip (unlike `ScreenTourTests`).
/// - Do not delete or loosen a test to make a design change pass. If a feature is removed or moved on
///   purpose, change the row in `docs/must-keep-features.md` in the same PR and say so in the PR body.
/// - Assert on what the person sees or does (a button by its label, the screen that opens), not on
///   colours or layout. Looks are the snapshot tests' job.
///
/// What these tests prove, and what they do not: a button exists, and the call or thread screen opens, on
/// DEMO data. They do not prove that a call connects (no microphone, no voice backend) or that data the
/// demo does not contain renders. Buttons are found by accessibility label, so the label is the contract.
///
/// Run: `scripts/run-must-keep.sh` (starts the demo server on a free port, runs these, stops it).
@MainActor
final class MustKeepTests: XCTestCase {
	private static let session =
		#"{"apiKey":"ank_demo","actorId":"00000000-0000-4000-8000-000000000002","name":"Sindre Aasen","email":"sindre@northwind.example","workspaceId":"00000000-0000-4000-8000-000000000001"}"#

	private var app = XCUIApplication()

	override func setUpWithError() throws {
		continueAfterFailure = false
		app = XCUIApplication()
		app.launchEnvironment["MASKIN_DEMO_SESSION"] = Self.session
		app.launch()
		XCTAssertTrue(app.tabBars.buttons["For you"].waitForExistence(timeout: 30), "signed-in shell")
	}

	// MARK: Helpers

	private func openChat(_ title: String) {
		let tab = app.tabBars.buttons["Chats"]
		XCTAssertTrue(tab.waitForExistence(timeout: 10), "Chats tab")
		tab.tap()
		let row = app.staticTexts[title].firstMatch
		XCTAssertTrue(row.waitForExistence(timeout: 15), "chat row '\(title)' in the Chats list")
		row.tap()
	}

	/// The in-call screen: only a call has End call and Minimise call. In the demo the call never connects
	/// (no microphone or voice backend: the status line reads "Couldn't connect the call"), so this proves
	/// the call screen opens, not that a call works.
	private func assertLiveCallScreen(_ what: String, file: StaticString = #filePath, line: UInt = #line) {
		let end = app.buttons["End call"].firstMatch
		if !end.waitForExistence(timeout: 15) { dumpScreen("call-screen-missing") }
		XCTAssertTrue(end.exists, "\(what): the live call screen (End call button) opens", file: file, line: line)
		XCTAssertTrue(
			app.buttons["Minimise call"].firstMatch.waitForExistence(timeout: 5),
			"\(what): the call card (Minimise call button) shows", file: file, line: line)
	}

	/// Leaves evidence of what the screen showed when a step fails: element tree and a screenshot.
	private func dumpScreen(_ name: String) {
		let dir = ProcessInfo.processInfo.environment["MUSTKEEP_DUMP_DIR"] ?? NSTemporaryDirectory()
		try? app.debugDescription.write(toFile: "\(dir)/\(name)-tree.txt", atomically: true, encoding: .utf8)
		try? XCUIScreen.main.screenshot().pngRepresentation.write(to: URL(fileURLWithPath: "\(dir)/\(name).png"))
	}

	// MARK: MK-01 Live briefing from For you

	/// For you → Live button in the top bar → the live call with the Chief of Staff.
	func testMK01_LiveBriefingFromForYou() throws {
		let live = app.buttons["Live briefing"].firstMatch
		XCTAssertTrue(live.waitForExistence(timeout: 10), "For you shows a 'Live briefing' button in the top bar")
		live.tap()
		assertLiveCallScreen("Live briefing from For you")
	}


	// MARK: MK-05 A long draft card opens in a chat without freezing

	/// Chief of Staff chat: a message links an email draft. Opening the card must leave the screen
	/// responsive (Approve shows), and scrolling up must offer Jump to latest, which works. A button
	/// that took room in the bottom inset once made opening a long card loop forever and froze the app.
	func testMK05_LongDraftCardOpensInChat() throws {
		openChat("Chief of Staff")
		let notNow = app.buttons["Not now"]
		if notNow.waitForExistence(timeout: 8) { notNow.tap() }
		let head = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Email,'")).firstMatch
		if !head.waitForExistence(timeout: 20) { dumpScreen("mk05-nocard") }
		XCTAssertTrue(head.exists, "the chat shows the email draft card")
		head.tap()
		let approve = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Approve'")).firstMatch
		if !approve.waitForExistence(timeout: 15) { dumpScreen("mk05-frozen") }
		XCTAssertTrue(approve.exists, "the opened card shows Approve, so the screen did not freeze")
		for _ in 0..<3 { app.swipeDown() }
		let jump = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Jump to latest'")).firstMatch
		XCTAssertTrue(jump.waitForExistence(timeout: 10), "scrolled up, the chat offers Jump to latest")
		jump.tap()
		XCTAssertTrue(approve.waitForExistence(timeout: 10), "Jump to latest brings the end of the card back")
	}

	// MARK: MK-02 Live with an agent from its chat

	/// Chats → an agent chat → a Live button → the live call. Where the button sits (chat header 'Live' or
	/// composer waveform 'Start a live conversation') is a design choice; that an agent chat offers one is
	/// not. Two chats: the Chief of Staff (one agent) and Outreach (a room with several), which take
	/// different paths in the app.
	private func assertLiveFromChat(_ chat: String) {
		openChat(chat)
		let live = app.buttons.matching(
			NSPredicate(format: "label == 'Live' OR label == 'Start a live conversation'")).firstMatch
		if !live.waitForExistence(timeout: 10) { dumpScreen("mk02-\(chat)") }
		XCTAssertTrue(live.exists, "the '\(chat)' chat offers a Live button (header or composer)")
		live.tap()
		assertLiveCallScreen("Live from the '\(chat)' chat")
	}

	func testMK02a_LiveWithChiefOfStaffFromChat() throws { assertLiveFromChat("Chief of Staff") }

	func testMK02b_LiveWithAgentRoomFromChat() throws { assertLiveFromChat("Outreach") }

	// MARK: MK-03 Reply in a thread

	/// Long-press a message → Reply in thread → the thread opens with a reply field.
	///
	/// Uses the Priya Rao chat, not an agent chat: the Live tests leave call records on the device that
	/// wrap an agent chat's messages in a call card, and a card's menu is only Copy and Share.
	func testMK03_ReplyInThread() throws {
		openChat("Priya Rao")
		let message = app.descendants(matching: .any)
			.matching(NSPredicate(format: "label CONTAINS 'I can review the Northwind draft'")).firstMatch
		if !message.waitForExistence(timeout: 15) {
			// Leave evidence: what the screen actually showed.
			let dir = ProcessInfo.processInfo.environment["MUSTKEEP_DUMP_DIR"] ?? NSTemporaryDirectory()
			try? app.debugDescription.write(toFile: "\(dir)/mk03-tree.txt", atomically: true, encoding: .utf8)
			try? XCUIScreen.main.screenshot().pngRepresentation.write(to: URL(fileURLWithPath: "\(dir)/mk03.png"))
			XCTFail("the chat's messages load (screen dumped to \(dir))")
		}
		message.press(forDuration: 1.0)
		let item = app.buttons["Reply in thread"].firstMatch
		if !item.waitForExistence(timeout: 5) { dumpScreen("mk03-menu") }
		XCTAssertTrue(item.exists, "a message's menu offers 'Reply in thread'")
		item.tap()
		let field = app.textFields.matching(NSPredicate(format: "label == 'Reply' OR placeholderValue == 'Reply'")).firstMatch
		XCTAssertTrue(field.waitForExistence(timeout: 10), "the thread screen opens with a Reply field")
	}

	// MARK: MK-04 A thread with replies

	/// Priya Rao chat: a message with two replies shows "2 replies", the replies stay out of the main
	/// timeline, and tapping the pill opens the thread with both replies. The demo data has one such
	/// thread (`fixtures.mjs`, room 302).
	func testMK04_ThreadWithRepliesOpens() throws {
		openChat("Priya Rao")
		func any(_ text: String) -> XCUIElement {
			app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", text)).firstMatch
		}
		XCTAssertTrue(any("Can you also check the pricing page?").waitForExistence(timeout: 15), "the root message shows")
		let pill = app.buttons.matching(NSPredicate(format: "label CONTAINS '2 replies'")).firstMatch
		if !pill.waitForExistence(timeout: 5) { dumpScreen("mk04-timeline") }
		XCTAssertTrue(pill.exists, "the root shows a '2 replies' pill")
		XCTAssertFalse(
			any("the pricing page looks right").exists, "replies are not shown in the main timeline")
		pill.tap()
		XCTAssertTrue(
			any("the pricing page looks right").waitForExistence(timeout: 10), "the thread shows the first reply")
		XCTAssertTrue(any("I will ship it today").waitForExistence(timeout: 5), "the thread shows the second reply")
	}
}
