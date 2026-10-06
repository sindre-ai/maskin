import XCTest

/// Live end-to-end walk of the signed-in app against a REAL API (`LIVE_API`).
///
/// Prereqs: API running, seeded with `live-verify/seed.sh` (writes `seed.env`, path in `LIVE_SEED_ENV`).
/// Env (pass through xcodebuild as `TEST_RUNNER_<NAME>`): `LIVE_API`, `LIVE_EMAIL`, `LIVE_PASSWORD`, `LIVE_SEED_ENV`, `LIVE_SHOTS_DIR`,
/// `LIVE_APPEARANCE` (light|dark), `LIVE_TAG` (screenshot filename prefix).
/// Verifies by query: after each UI write the test GETs the row back from the API.
@MainActor
final class LiveFlowTests: LiveTestCase {
	// MARK: Flows

	func test1_SignInAndForYouDecision() throws {
		try postFreshDecision()
		try signInIfNeeded()
		XCTAssertTrue(app.staticTexts["Ship the iOS beta now?"].waitForExistence(timeout: 20), "decision card headline")
		shot("foryou-card")
		let option = app.buttons.matching(NSPredicate(format: "label CONTAINS 'Ship today'")).firstMatch
		XCTAssertTrue(option.waitForExistence(timeout: 5), "option button")
		option.tap()
		XCTAssertTrue(el("You chose Ship today").waitForExistence(timeout: 10), "receipt after choosing")
		shot("foryou-chose")
		// Verify by query: the reply comment exists on the bet.
		// The choice is held for the undo window (6s) before it is sent.
		let events = try waitForServer("/events/history?entity_id=\(seed["BET"]!)&limit=20", contains: "Ship today")
		XCTAssertTrue(events.contains("Ship today"), "the choice was persisted as a comment: \(events.prefix(400))")
	}

	func test2_Chats() throws {
		try signInIfNeeded()
		openSidebarTab("Chats")
		let row = el("Launch planning")
		if !row.waitForExistence(timeout: 15) {
			shot("chats-missing-row")
			let dump = "\(shotsDir)/\(tag)-chats-debugDescription.txt"
			try? app.debugDescription.write(toFile: dump, atomically: true, encoding: .utf8)
			XCTFail("seeded conversation row missing; UI tree dumped to \(dump)")
			return
		}
		shot("chats-list")
		row.tap()
		XCTAssertTrue(el("where are we on the beta").waitForExistence(timeout: 10), "seeded human message")
		shot("chat-thread")
		let composer = app.textFields.matching(NSPredicate(format: "placeholderValue CONTAINS 'Message'")).firstMatch
		XCTAssertTrue(composer.waitForExistence(timeout: 5), "composer")
		composer.tap()
		let text = "Ship it from XCUITest \(Int(Date().timeIntervalSince1970))"
		composer.typeText(text)
		app.buttons["Send"].tap()
		XCTAssertTrue(app.staticTexts[text].waitForExistence(timeout: 10), "sent message appears")
		shot("chat-sent")
		let msgs = try get("/conversations/\(seed["CONV"]!)/messages", key: seed["KEY"]!)
		XCTAssertTrue(msgs.contains(text), "message persisted server-side")
		// SSE: an agent message posted over REST appears live.
		let live = "Live from the agent \(Int(Date().timeIntervalSince1970))"
		try post("/conversations/\(seed["CONV"]!)/messages", body: ["content": live], key: seed["AKEY"]!)
		XCTAssertTrue(app.staticTexts[live].waitForExistence(timeout: 10), "SSE-delivered agent message appears without refresh")
		shot("chat-live")
	}

	func test3_ObjectsAndComment() throws {
		try signInIfNeeded()
		openSidebarTab("Objects")
		try postFreshDecision()
		let row = el("Ship a native iOS app")
		XCTAssertTrue(row.waitForExistence(timeout: 15), "bet row")
		shot("objects-list")
		row.tap()
		sleep(2)
		shot("object-detail-fresh")
		let option = app.buttons.matching(NSPredicate(format: "label CONTAINS 'Ship today'")).firstMatch
		XCTAssertTrue(option.waitForExistence(timeout: 10), "open decision options visible in object detail")
		// Lands at the top: the header (type title in the bar, status row) and the decision are on screen.
		XCTAssertTrue(app.navigationBars["Bet"].exists, "nav title")
		XCTAssertTrue(el("No owner").isHittable || el("Updated").isHittable, "header row visible, not scrolled away")
		XCTAssertTrue(option.isHittable, "decision option on screen at open")
		XCTAssertTrue(el("Offline outbox").waitForExistence(timeout: 10), "markdown body")
		shot("object-detail")
		let composer = app.textFields["Comment"]
		XCTAssertTrue(composer.waitForExistence(timeout: 5), "comment composer")
		composer.tap()
		let text = "UI comment \(Int(Date().timeIntervalSince1970))"
		composer.typeText(text)
		app.buttons["Send"].tap()
		XCTAssertTrue(app.staticTexts[text].waitForExistence(timeout: 10), "comment appears")
		shot("object-commented")
		let events = try get("/events/history?entity_id=\(seed["BET"]!)&limit=20")
		XCTAssertTrue(events.contains(text), "comment persisted")
	}

	func test4_NotificationsSheet() throws {
		try signInIfNeeded()
		let bell = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Notifications'")).firstMatch
		XCTAssertTrue(bell.waitForExistence(timeout: 10), "bell")
		shot("bell")
		bell.tap()
		XCTAssertTrue(app.navigationBars["Notifications"].waitForExistence(timeout: 10), "sheet")
		sleep(2)
		shot("notifications")
		XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS 'your call' OR label CONTAINS 'mentioned' OR label CONTAINS 'needs your review'")).firstMatch.exists, "seeded notification listed")
	}

	func test5_SignOutAndBackIn() throws {
		try signInIfNeeded()
		let account = app.buttons["Account"].firstMatch
		XCTAssertTrue(account.waitForExistence(timeout: 10), "account menu")
		account.tap()
		shot("account-menu")
		app.buttons["Sign out"].tap()
		confirmSignOutDialog()
		XCTAssertTrue(app.textFields["Email"].waitForExistence(timeout: 10), "back at login")
		shot("login")
		try signIn()
		XCTAssertTrue(app.staticTexts["Ship the iOS beta now?"].waitForExistence(timeout: 20) || app.buttons["Account"].exists, "signed in again")
		shot("signed-in-again")
	}

	func test0_WrongPassword() throws {
		if !app.textFields["Email"].waitForExistence(timeout: 5) { return }  // already signed in; covered after sign-out
		try signIn(password: "definitely-wrong")
		let err = app.staticTexts.matching(NSPredicate(format: "label CONTAINS \"don't match\"")).firstMatch
		XCTAssertTrue(err.waitForExistence(timeout: 10), "invalid credentials message")
		shot("login-error")
	}

	// MARK: Helpers

	/// A fresh ask (a chosen decision is consumed), posted by the agent over REST.
	private func postFreshDecision() throws {
		let decision: [String: Any] = [
			"title": "Ship the iOS beta now?",
			"summary": "Crash-free sessions sit at 99 percent across 120 test runs. The build is signed and the TestFlight group is ready.",
			"ask": "I cannot release to real testers without your sign-off.",
			"options": [
				["label": "Ship today", "recommended": true, "consequences": ["Reaches 40 testers this week", "Adds 3 support tickets a day"]],
				["label": "Hold a week", "consequences": ["Delays feedback by 7 days", "Lets us fix 2 known bugs"]],
			],
		]
		try post("/events", body: ["entity_id": seed["BET"]!, "content": "Beta is ready for **your call** \(Int(Date().timeIntervalSince1970)).", "mentions": [seed["ME"]!], "attention": 4, "decision": decision], key: seed["AKEY"]!)
	}
}
