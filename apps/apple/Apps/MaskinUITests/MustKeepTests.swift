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
/// Runs against the offline demo workspace, no real backend:
///
///   PORT=3010 node scripts/demo-server/server.mjs
///   xcodebuild test -project Maskin.xcodeproj -scheme Maskin -destination 'platform=iOS Simulator,name=iPhone 17' \
///     MASKIN_API_BASE_URL=http://localhost:3010 -only-testing:MaskinUITests/MustKeepTests
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

	/// The in-call screen: only a running live call has an End call button.
	private func assertLiveCallScreen(_ what: String, file: StaticString = #filePath, line: UInt = #line) {
		XCTAssertTrue(
			app.buttons["End call"].firstMatch.waitForExistence(timeout: 15),
			"\(what): the live call screen (End call button) opens", file: file, line: line)
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
		XCTAssertTrue(
			app.staticTexts["Chief of Staff"].firstMatch.waitForExistence(timeout: 5), "the call is with the Chief of Staff")
	}

	// MARK: MK-02 Live with an agent from its chat

	/// Chats → the Chief of Staff chat → a Live button → the live call. Where the button sits (chat
	/// header 'Live' or composer waveform 'Start a live conversation') is a design choice; that an
	/// agent chat offers one is not.
	func testMK02_LiveWithAgentFromChat() throws {
		openChat("Chief of Staff")
		let live = app.buttons.matching(
			NSPredicate(format: "label == 'Live' OR label == 'Start a live conversation'")).firstMatch
		if !live.waitForExistence(timeout: 10) { dumpScreen("mk02-chat") }
		XCTAssertTrue(live.exists, "an agent chat offers a Live button (header or composer)")
		live.tap()
		assertLiveCallScreen("Live with an agent from its chat")
	}

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
}
