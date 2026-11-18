import UIKit
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
		// The notification sheet covers For you once the feed shows a decision, and swallows the first taps.
		let notNow = app.buttons["Not now"]
		if notNow.waitForExistence(timeout: 10) {
			notNow.tap()
			_ = notNow.waitForNonExistence(timeout: 5)
		}
	}

	// MARK: Helpers

	/// The Chats list row for a chat. A row is one element whose label reads "names, title, preview", so the
	/// title is not a text of its own for group chats; a direct message row still shows its name as a text.
	/// Lists load lazily: scroll if the row is not on screen yet. Leaves a screenshot and tree when it is missing.
	private func chatRow(_ title: String) -> XCUIElement {
		let byText = app.staticTexts[title].firstMatch
		let byLabel = app.descendants(matching: .any).matching(
			NSPredicate(format: "label BEGINSWITH %@ OR label CONTAINS %@", title + ",", ", " + title)
		).firstMatch
		for round in 0..<5 {
			let deadline = Date().addingTimeInterval(round == 0 ? 10 : 2)
			while Date() < deadline {
				if byText.exists { return byText }
				if byLabel.exists { return byLabel }
				Thread.sleep(forTimeInterval: 0.5)
			}
			app.swipeUp()
		}
		dumpScreen("chats-list-missing-\(title.replacingOccurrences(of: " ", with: "-"))")
		return byText
	}

	private func openChat(_ title: String) {
		let tab = app.tabBars.buttons["Chats"]
		XCTAssertTrue(tab.waitForExistence(timeout: 10), "Chats tab")
		tab.tap()
		let row = chatRow(title)
		XCTAssertTrue(row.exists, "chat row '\(title)' in the Chats list")
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

	/// Priya Rao chat (not an agent chat, so a Live call record cannot fold it into a call card): a message links an email draft. Opening the card must leave the screen
	/// responsive (Approve shows), and scrolling up must offer Jump to latest, which works. A button
	/// that took room in the bottom inset once made opening a long card loop forever and froze the app.
	func testMK05_LongDraftCardOpensInChat() throws {
		openChat("Priya Rao")
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
		XCTAssertTrue(jump.waitForNonExistence(timeout: 10), "Jump to latest takes the chat to the bottom, and the button goes away")
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

	/// Tap a message's More button → Reply in thread → the thread opens with a reply field.
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
		// A long-press now selects words; the menu is behind the More button beside the message.
		let inRow = message.buttons["More"].firstMatch
		(inRow.exists ? inRow : app.buttons["More"].firstMatch).tap()
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

	// MARK: Helpers for MK-06 to MK-09

	/// Closes the notification pre-prompt if it shows over a chat; it would swallow the first tap.
	private func dismissNotNow() {
		let notNow = app.buttons["Not now"]
		if notNow.waitForExistence(timeout: 3) { notNow.tap() }
	}

	/// The message field of the open chat (its accessibility label is the placeholder, "Message {name}").
	private func composerField() -> XCUIElement {
		let kinds = [XCUIElement.ElementType.textField.rawValue, XCUIElement.ElementType.textView.rawValue]
		return app.descendants(matching: .any).matching(
			NSPredicate(format: "(elementType == %d OR elementType == %d) AND label BEGINSWITH 'Message'", kinds[0], kinds[1])
		).firstMatch
	}

	/// Anything on screen with exactly this label (a menu row can be a button or a menu item).
	private func element(labelled label: String) -> XCUIElement {
		app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", label)).firstMatch
	}

	/// A picture on the system clipboard, made here so the tests need no fixture file.
	private func putImageOnClipboard() {
		let size = CGSize(width: 40, height: 40)
		UIPasteboard.general.image = UIGraphicsImageRenderer(size: size).image { context in
			UIColor.systemOrange.setFill()
			context.fill(CGRect(origin: .zero, size: size))
		}
	}

	/// Long-presses the message field until its edit menu shows Paste (the first press can only focus the
	/// field, so it tries a few times). Returns the Paste item; it may not exist, the caller asserts.
	private func fieldMenuPaste(_ field: XCUIElement, dump name: String) -> XCUIElement {
		let paste = element(labelled: "Paste")
		for _ in 0..<3 where !paste.exists {
			field.press(forDuration: 1.0)
			_ = paste.waitForExistence(timeout: 3)
		}
		if !paste.exists { dumpScreen(name) }
		return paste
	}

	/// Taps Paste in the field's edit menu. Paste from another process (the test) makes iOS ask "Allow
	/// Paste": answer it.
	private func pasteIntoField(_ field: XCUIElement) {
		let paste = fieldMenuPaste(field, dump: "mk09-paste-menu")
		XCTAssertTrue(paste.exists, "the message field's menu offers Paste")
		paste.tap()
		let allow = XCUIApplication(bundleIdentifier: "com.apple.springboard").buttons["Allow Paste"]
		if allow.waitForExistence(timeout: 3) { allow.tap() }
	}

	// MARK: MK-06 Search finds a chat, and a long-press on the result shows its menu

	/// For you → Account → Search, type a chat's name, long-press the chat in the results: the same menu
	/// as the Chats list (Pin to top, Archive, Delete). A result that shows no menu is the bug this row keeps out.
	func testMK06_SearchResultLongPressMenu() throws {
		let account = app.buttons["Account"].firstMatch
		XCTAssertTrue(account.waitForExistence(timeout: 10), "For you shows the Account button")
		account.tap()
		XCTAssertTrue(app.staticTexts["Profile"].waitForExistence(timeout: 10), "the profile sheet opens")
		// The screen under the sheet may have a Search button of its own (it is not hittable): take the sheet's.
		// (isHittable is not a predicate key, so filter the matches in code.)
		func hittableSearch() -> XCUIElement? {
			app.buttons.matching(NSPredicate(format: "label == 'Search'")).allElementsBoundByIndex.first { $0.isHittable }
		}
		for _ in 0..<4 where hittableSearch() == nil { app.swipeUp() }
		if hittableSearch() == nil { dumpScreen("mk06-search-row") }
		let searchRow = hittableSearch()
		XCTAssertNotNil(searchRow, "the profile sheet offers Search")
		searchRow?.tap()
		let field = app.searchFields.firstMatch
		XCTAssertTrue(field.waitForExistence(timeout: 10), "Search opens with a search field")
		field.tap()
		field.typeText("Priya")
		let result = app.buttons.matching(NSPredicate(format: "label CONTAINS 'Priya Rao'")).firstMatch
		if !result.waitForExistence(timeout: 15) { dumpScreen("mk06-results") }
		XCTAssertTrue(result.exists, "searching 'Priya' finds the Priya Rao chat")
		// The menu needs the chat list behind it, which loads after the results show: press again if it is not there yet.
		let pin = element(labelled: "Pin to top")
		for _ in 0..<4 where !pin.exists {
			result.press(forDuration: 1.2)
			_ = pin.waitForExistence(timeout: 3)
		}
		if !pin.exists { dumpScreen("mk06-menu") }
		XCTAssertTrue(pin.exists, "a long-press on the chat result shows its menu (Pin to top)")
		XCTAssertTrue(element(labelled: "Archive").exists, "the menu offers Archive")
		XCTAssertTrue(element(labelled: "Delete").exists, "the menu offers Delete")
	}

	// MARK: MK-07 The composer offers Paste when a picture is on the clipboard

	/// MK-07a: long-press in the message field: the system menu offers Paste. Keyboard paste of a screenshot
	/// is the same path.
	func testMK07a_FieldMenuOffersPasteForImage() throws {
		putImageOnClipboard()
		openChat("Priya Rao")
		dismissNotNow()
		let field = composerField()
		XCTAssertTrue(field.waitForExistence(timeout: 15), "the chat shows its message field")
		field.tap()
		let paste = fieldMenuPaste(field, dump: "mk07a-menu")
		XCTAssertTrue(paste.exists, "with a picture on the clipboard, the message field's menu offers Paste")
	}

	/// MK-07b: the + menu lists "Paste image" while the clipboard holds a picture.
	func testMK07b_AttachMenuOffersPasteImage() throws {
		putImageOnClipboard()
		openChat("Priya Rao")
		dismissNotNow()
		let attach = app.buttons["Attach"].firstMatch
		XCTAssertTrue(attach.waitForExistence(timeout: 15), "the chat shows the Attach (+) button")
		attach.tap()
		let row = element(labelled: "Paste image")
		if !row.waitForExistence(timeout: 5) { dumpScreen("mk07b-menu") }
		XCTAssertTrue(row.exists, "with a picture on the clipboard, the + menu offers 'Paste image'")
	}

	// MARK: MK-08 Type a message and send it

	/// Webinars chat (sending changes the chat, and the other rows rely on the Priya Rao and Live chats staying
	/// as they are): type a line, tap Send, and the line shows in the chat. The demo server keeps what it was sent.
	func testMK08_TypeAndSendShowsMessage() throws {
		openChat("Webinars")
		dismissNotNow()
		let field = composerField()
		XCTAssertTrue(field.waitForExistence(timeout: 15), "the chat shows its message field")
		field.tap()
		let line = "Sent by the must keep test \(Int(Date().timeIntervalSince1970) % 100_000)"
		field.typeText(line)
		let send = app.buttons["Send"].firstMatch
		XCTAssertTrue(send.waitForExistence(timeout: 5), "typing a line shows the Send button")
		send.tap()
		let sent = app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", line)).firstMatch
		if !sent.waitForExistence(timeout: 20) { dumpScreen("mk08-sent") }
		XCTAssertTrue(sent.exists, "the sent line shows in the chat")
	}

	// MARK: MK-09 A message over 8000 characters goes as a file

	/// Paste 8,200 characters, see the notice that it will go as a file, send it: the chat shows the short
	/// message that points at the attached file. The text is pasted because typing 8,000 characters takes minutes.
	func testMK09_LongMessageSendsAsFile() throws {
		UIPasteboard.general.string = String(repeating: "Long message words. ", count: 410)
		openChat("Webinars")
		dismissNotNow()
		let field = composerField()
		XCTAssertTrue(field.waitForExistence(timeout: 15), "the chat shows its message field")
		field.tap()
		pasteIntoField(field)
		let notice = app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS 'Over 8,000 characters'")).firstMatch
		if !notice.waitForExistence(timeout: 10) { dumpScreen("mk09-notice") }
		XCTAssertTrue(notice.exists, "over 8,000 characters the composer says the message will be attached as a file")
		let send = app.buttons["Send"].firstMatch
		XCTAssertTrue(send.waitForExistence(timeout: 5), "Send is on for a long message")
		send.tap()
		let sent = app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS 'is attached as message-'")).firstMatch
		if !sent.waitForExistence(timeout: 30) { dumpScreen("mk09-sent") }
		XCTAssertTrue(sent.exists, "the chat shows the short message that points at the attached file")
	}
}
