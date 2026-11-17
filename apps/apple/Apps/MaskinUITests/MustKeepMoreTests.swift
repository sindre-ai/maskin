import XCTest

/// MUST-KEEP features of the iPhone app, part two: rows MK-10 and up of `docs/must-keep-features.md`.
/// The same rules as `MustKeepTests`:
/// - A step that cannot be reached is a FAILURE, never a skip.
/// - Do not delete or loosen a test to make a design change pass. If a feature is removed or moved on
///   purpose, change the row in the doc in the same PR and say so in the PR body.
/// - Assert on what the person sees or does (a button by its label, the screen that opens), not on
///   colours or layout.
///
/// Why a second file: the first rows live in `MustKeepTests.swift`, which other PRs edit. Rows here use the
/// "Contoso renewal" chat (`scripts/demo-server/must-keep-fixtures.mjs`), which no other row reads, so the
/// edits, reactions and sends in it cannot change what another row sees.
///
/// What these tests prove, and what they do not: a button exists and a screen opens, on DEMO data. Each row
/// in the doc states its own limit. Run: `scripts/run-must-keep.sh MustKeepMoreTests`.
@MainActor
final class MustKeepMoreTests: XCTestCase {
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

	/// Closes the notification pre-prompt if it shows over a chat; it would swallow the first tap.
	private func dismissNotNow() {
		let notNow = app.buttons["Not now"]
		if notNow.waitForExistence(timeout: 3) { notNow.tap() }
	}

	/// Anything on screen whose label contains `text`.
	private func anyLabel(containing text: String) -> XCUIElement {
		app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", text)).firstMatch
	}

	/// Anything on screen with exactly this label (a menu row can be a button or a menu item).
	private func element(labelled label: String) -> XCUIElement {
		app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", label)).firstMatch
	}

	/// The message field of the open chat (its accessibility label is the placeholder, "Message {name}").
	private func composerField() -> XCUIElement {
		let kinds = [XCUIElement.ElementType.textField.rawValue, XCUIElement.ElementType.textView.rawValue]
		return app.descendants(matching: .any).matching(
			NSPredicate(format: "(elementType == %d OR elementType == %d) AND label BEGINSWITH 'Message'", kinds[0], kinds[1])
		).firstMatch
	}

	/// Leaves evidence of what the screen showed when a step fails: element tree and a screenshot.
	private func dumpScreen(_ name: String) {
		let dir = ProcessInfo.processInfo.environment["MUSTKEEP_DUMP_DIR"] ?? NSTemporaryDirectory()
		try? app.debugDescription.write(toFile: "\(dir)/\(name)-tree.txt", atomically: true, encoding: .utf8)
		try? XCUIScreen.main.screenshot().pngRepresentation.write(to: URL(fileURLWithPath: "\(dir)/\(name).png"))
	}

	/// Waits for `element`, and dumps the screen under `name` if it never shows.
	@discardableResult
	private func expectExists(_ element: XCUIElement, _ what: String, dump name: String, timeout: TimeInterval = 15, file: StaticString = #filePath, line: UInt = #line) -> XCUIElement {
		if !element.waitForExistence(timeout: timeout) { dumpScreen(name) }
		XCTAssertTrue(element.exists, what, file: file, line: line)
		return element
	}

	/// Taps the More button beside the message that `row` finds, or the lowest More on screen when the
	/// button is not inside the row's element (the newest message sits at the bottom of the chat).
	private func tapMore(on row: XCUIElement) {
		let inRow = row.buttons["More"].firstMatch
		if inRow.exists {
			inRow.tap()
		} else {
			let all = app.buttons.matching(NSPredicate(format: "label == 'More'")).allElementsBoundByIndex
			XCTAssertFalse(all.isEmpty, "the chat shows a More button on its messages")
			all.last?.tap()
		}
	}

	/// Opens the profile sheet from For you.
	private func openProfile() {
		app.tabBars.buttons["For you"].tap()
		let account = app.buttons["Account"].firstMatch
		XCTAssertTrue(account.waitForExistence(timeout: 10), "For you shows the Account button")
		account.tap()
		XCTAssertTrue(app.staticTexts["Profile"].waitForExistence(timeout: 10), "the profile sheet opens")
	}

	/// Scrolls up until the element is on screen and can be tapped.
	private func scrollToHittable(_ element: XCUIElement) {
		for _ in 0..<6 where !(element.exists && element.isHittable) { app.swipeUp() }
	}

	// MARK: MK-10 An agent's reply inside a thread is reachable

	/// Contoso renewal chat: a message with two replies, the first from the Chief of Staff (an agent). Opening
	/// the thread shows the agent's words. The agent reply is the part MK-04 (a thread of people) does not cover.
	func testMK10_AgentReplyInThreadIsReachable() throws {
		openChat("Contoso renewal")
		dismissNotNow()
		let pill = app.buttons.matching(NSPredicate(format: "label CONTAINS '2 replies'")).firstMatch
		expectExists(pill, "the root message shows a '2 replies' pill", dump: "mk10-pill")
		pill.tap()
		expectExists(
			anyLabel(containing: "Clause 7. Auto-renewal needs 60 days notice"), "the thread shows the agent's reply", dump: "mk10-thread",
			timeout: 10)
		XCTAssertTrue(anyLabel(containing: "Thanks, I will raise it with Contoso").waitForExistence(timeout: 5), "the thread shows the person's reply")
	}

	// MARK: MK-11 The Threads list opens a thread

	/// Chats → Threads: the list names the chat and the newest reply; tapping a row opens the thread with the
	/// agent's reply. The Threads button is a chip or a row at the top of Chats, depending on a setting: either way
	/// its label starts with "Threads".
	func testMK11_ThreadsListOpensThread() throws {
		let tab = app.tabBars.buttons["Chats"]
		XCTAssertTrue(tab.waitForExistence(timeout: 10), "Chats tab")
		tab.tap()
		let threads = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Threads'")).firstMatch
		expectExists(threads, "Chats offers a Threads button", dump: "mk11-button")
		threads.tap()
		XCTAssertTrue(app.navigationBars["Threads"].waitForExistence(timeout: 10), "the Threads list opens")
		let row = app.buttons.matching(NSPredicate(format: "label CONTAINS 'Contoso renewal'")).firstMatch
		expectExists(row, "the Threads list shows the Contoso renewal thread", dump: "mk11-list")
		row.tap()
		expectExists(
			anyLabel(containing: "Clause 7. Auto-renewal needs 60 days notice"), "the thread opens with the agent's reply", dump: "mk11-thread",
			timeout: 10)
	}

	// MARK: MK-12 Pick a decision option on For you

	/// For you: the first card asks "Send 7 follow-ups to Northwind?". Tapping its recommended option takes the
	/// card out of the open list and shows what was chosen, with Undo. The demo only records a comment, so nothing
	/// is sent anywhere.
	func testMK12_PickDecisionOptionOnForYou() throws {
		app.tabBars.buttons["For you"].tap()
		let option = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Send all 7'")).firstMatch
		for _ in 0..<4 where !option.exists { app.swipeUp() }
		expectExists(option, "For you shows the decision option 'Send all 7'", dump: "mk12-option")
		option.tap()
		XCTAssertTrue(option.waitForNonExistence(timeout: 10), "the card leaves the open list once an option is picked")
		let chosen = app.descendants(matching: .any).matching(
			NSPredicate(format: "label CONTAINS 'Send all 7' AND NOT (label ENDSWITH 'recommended')")
		).firstMatch
		if !chosen.waitForExistence(timeout: 15) { dumpScreen("mk12-receipt") }
		XCTAssertTrue(chosen.exists, "the choice shows as a receipt or toast ('You chose Send all 7')")
		XCTAssertTrue(app.buttons["Undo"].firstMatch.waitForExistence(timeout: 5), "the choice offers Undo")
	}

	// MARK: MK-13 @mention someone

	/// Priya Rao chat: typing @ and the start of a name lists people; picking one turns it into a chip in the
	/// composer. The message is not sent, so no row changes the chat.
	func testMK13_MentionSomeoneInComposer() throws {
		openChat("Priya Rao")
		dismissNotNow()
		let field = composerField()
		XCTAssertTrue(field.waitForExistence(timeout: 15), "the chat shows its message field")
		field.tap()
		field.typeText("@Pri")
		let pick = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Mention Priya Rao'")).firstMatch
		expectExists(pick, "typing @Pri lists Priya Rao to mention", dump: "mk13-list", timeout: 10)
		pick.tap()
		expectExists(
			app.buttons["Remove mention of Priya Rao"], "the picked person becomes a chip in the composer", dump: "mk13-chip",
			timeout: 10)
		XCTAssertTrue(pick.waitForNonExistence(timeout: 5), "the list closes after a pick")
	}

	// MARK: MK-14 Sign out and sign in

	/// Profile sheet → Sign out → confirm → the sign-in screen; then sign in again → For you. The demo server
	/// accepts any email and password.
	func testMK14_SignOutAndSignIn() throws {
		openProfile()
		let signOut = app.buttons["Sign out"].firstMatch
		scrollToHittable(signOut)
		expectExists(signOut, "the profile sheet offers Sign out", dump: "mk14-row", timeout: 5)
		signOut.tap()
		expectExists(anyLabel(containing: "Sign out of Maskin?"), "signing out asks to confirm", dump: "mk14-confirm", timeout: 8)
		// The dialog's button has the same label as the row; the last match is the dialog's.
		app.buttons.matching(NSPredicate(format: "label == 'Sign out'")).allElementsBoundByIndex.last?.tap()
		let email = app.textFields.matching(NSPredicate(format: "label == 'Email' OR placeholderValue == 'you@company.com'")).firstMatch
		expectExists(email, "after signing out, the sign-in screen asks for an email", dump: "mk14-login", timeout: 20)
		email.tap()
		email.typeText("sindre@northwind.example")
		let password = app.secureTextFields.firstMatch
		XCTAssertTrue(password.waitForExistence(timeout: 5), "the sign-in screen asks for a password")
		password.tap()
		password.typeText("Northwind-demo-1")
		// The mode switch above the form is also a button called "Sign in": the form's own is the last one.
		let submit = app.buttons.matching(NSPredicate(format: "label == 'Sign in'")).allElementsBoundByIndex.last
		XCTAssertNotNil(submit, "the sign-in form has a Sign in button")
		submit?.tap()
		if !app.tabBars.buttons["For you"].waitForExistence(timeout: 30) { dumpScreen("mk14-signedin") }
		XCTAssertTrue(app.tabBars.buttons["For you"].exists, "signing in again opens the app on For you")
	}

	// MARK: MK-15 Edit, react to, and delete a message

	/// MK-15a: your newest message offers Edit. The words go back into the field under "Editing message",
	/// and sending the change shows the new words.
	func testMK15a_EditOwnNewestMessage() throws {
		openChat("Contoso renewal")
		dismissNotNow()
		let mine = anyLabel(containing: "Draft the counter offer for Contoso")
		expectExists(mine, "the chat shows your newest message", dump: "mk15a-message")
		tapMore(on: mine)
		let edit = element(labelled: "Edit")
		expectExists(edit, "your newest message's menu offers Edit", dump: "mk15a-menu", timeout: 5)
		edit.tap()
		expectExists(app.buttons["Cancel editing"], "the composer says it is editing the message", dump: "mk15a-strip", timeout: 5)
		let field = composerField()
		XCTAssertTrue(field.waitForExistence(timeout: 5), "the message field shows")
		// Editing puts the cursor at the end of the words and focuses the field: type there, without tapping.
		let focused = XCTNSPredicateExpectation(predicate: NSPredicate(format: "hasKeyboardFocus == true"), object: field)
		_ = XCTWaiter().wait(for: [focused], timeout: 5)
		field.typeText(" (edited by the test)")
		let send = app.buttons["Send"].firstMatch
		XCTAssertTrue(send.waitForExistence(timeout: 5), "the composer offers Send for the edit")
		send.tap()
		expectExists(
			anyLabel(containing: "Draft the counter offer for Contoso. (edited by the test)"), "the chat shows the edited words", dump: "mk15a-after",
			timeout: 15)
	}

	/// MK-15b: a message's menu offers React; picking an emoji puts a count chip under the message.
	func testMK15b_ReactToMessage() throws {
		openChat("Contoso renewal")
		dismissNotNow()
		let message = anyLabel(containing: "Contoso asked for a 12-month term")
		expectExists(message, "the chat shows the Chief of Staff's first message", dump: "mk15b-message")
		tapMore(on: message)
		let react = element(labelled: "React")
		expectExists(react, "a message's menu offers React", dump: "mk15b-menu", timeout: 5)
		react.tap()
		let thumbs = element(labelled: "👍")
		expectExists(thumbs, "React offers the thumbs-up emoji", dump: "mk15b-emoji", timeout: 5)
		thumbs.tap()
		expectExists(element(labelled: "👍, 1"), "the message shows a 👍 chip with a count of 1", dump: "mk15b-chip", timeout: 10)
	}

	/// MK-15c: a message the server refused stays in the chat as "Not sent", and its menu offers Delete. The demo
	/// server refuses any text with REJECT in it. The app has no delete for a message that was sent.
	func testMK15c_DeleteUnsentMessage() throws {
		openChat("Contoso renewal")
		dismissNotNow()
		let field = composerField()
		XCTAssertTrue(field.waitForExistence(timeout: 15), "the chat shows its message field")
		field.tap()
		let line = "REJECT this one \(Int(Date().timeIntervalSince1970) % 100_000)"
		field.typeText(line)
		let send = app.buttons["Send"].firstMatch
		XCTAssertTrue(send.waitForExistence(timeout: 5), "typing a line shows the Send button")
		send.tap()
		// The send is held for a few seconds so it can be undone, then the server says no.
		let notSent = app.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH 'Not sent'")).firstMatch
		expectExists(notSent, "a refused message shows 'Not sent'", dump: "mk15c-notsent", timeout: 45)
		let row = anyLabel(containing: line)
		tapMore(on: row)
		let delete = element(labelled: "Delete")
		expectExists(delete, "an unsent message's menu offers Delete", dump: "mk15c-menu", timeout: 5)
		delete.tap()
		XCTAssertTrue(notSent.waitForNonExistence(timeout: 10), "Delete removes the unsent message from the chat")
	}

	// MARK: MK-16 Attach a file

	/// Priya Rao chat: the + (Attach) menu lists File, and File opens the system file picker. Nothing is picked,
	/// because the picker is a system screen the test cannot choose a file in.
	func testMK16_AttachMenuOpensFilePicker() throws {
		openChat("Priya Rao")
		dismissNotNow()
		let attach = app.buttons["Attach"].firstMatch
		expectExists(attach, "the chat shows the Attach (+) button", dump: "mk16-attach")
		attach.tap()
		let file = app.buttons["File"].firstMatch
		expectExists(file, "the + menu lists File", dump: "mk16-menu", timeout: 5)
		file.tap()
		// The picker is the system's: its Cancel or Close button, or its Browse and Recents tabs.
		let picker = app.descendants(matching: .any).matching(
			NSPredicate(format: "label IN {'Cancel', 'Close', 'Browse', 'Recents'}")
		).firstMatch
		expectExists(picker, "File opens the system file picker", dump: "mk16-picker", timeout: 15)
	}

	// MARK: MK-17 Connect an integration with a key

	/// Profile sheet → Settings → Integrations → Discover → PostHog (connects with a pasted key) → paste a key →
	/// Connect: PostHog is in the Connected list. OAuth providers open a system sign-in sheet that the demo cannot
	/// finish, so this row uses the one provider that connects inside the app.
	func testMK17_ConnectIntegrationWithKey() throws {
		openProfile()
		let settings = app.buttons["Settings"].firstMatch
		scrollToHittable(settings)
		expectExists(settings, "the profile sheet offers Settings", dump: "mk17-settings", timeout: 5)
		settings.tap()
		let integrations = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Integrations'")).firstMatch
		for _ in 0..<6 where !integrations.exists { app.swipeUp() }
		expectExists(integrations, "Settings lists Integrations", dump: "mk17-row", timeout: 5)
		scrollToHittable(integrations)
		integrations.tap()
		let discover = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Discover'")).firstMatch
		expectExists(discover, "Integrations has a Discover tab", dump: "mk17-discover")
		discover.tap()
		let posthog = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'PostHog'")).firstMatch
		expectExists(posthog, "Discover lists PostHog", dump: "mk17-posthog", timeout: 10)
		posthog.tap()
		let keyField = app.descendants(matching: .any).matching(NSPredicate(format: "placeholderValue == 'Paste your key'")).firstMatch
		expectExists(keyField, "PostHog asks for a key", dump: "mk17-key", timeout: 10)
		keyField.tap()
		keyField.typeText("phc_demo_key_1234")
		let connect = app.buttons["Connect"].firstMatch
		XCTAssertTrue(connect.waitForExistence(timeout: 5), "the key page has a Connect button")
		connect.tap()
		// Back on the list: the Connected tab now has PostHog.
		let connected = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Connected'")).firstMatch
		expectExists(connected, "Integrations has a Connected tab", dump: "mk17-back", timeout: 15)
		connected.tap()
		let row = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'PostHog'")).firstMatch
		expectExists(row, "PostHog is in the Connected list", dump: "mk17-connected", timeout: 15)
	}
}
