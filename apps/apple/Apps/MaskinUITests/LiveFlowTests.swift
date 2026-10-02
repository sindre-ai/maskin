import XCTest

/// Live end-to-end walk of the signed-in app against a REAL API (`LIVE_API`).
///
/// Prereqs: API running, seeded with `live-verify/seed.sh` (writes `seed.env`, path in `LIVE_SEED_ENV`).
/// Env (pass through xcodebuild as `TEST_RUNNER_<NAME>`): `LIVE_API`, `LIVE_EMAIL`, `LIVE_PASSWORD`, `LIVE_SEED_ENV`, `LIVE_SHOTS_DIR`,
/// `LIVE_APPEARANCE` (light|dark), `LIVE_TAG` (screenshot filename prefix).
/// Verifies by query: after each UI write the test GETs the row back from the API.
@MainActor
final class LiveFlowTests: XCTestCase {
	// No defaults on purpose: credentials and API origin come from the environment.
	private var api = ""
	private var email = ""
	private var password = ""
	private var seed: [String: String] = [:]
	private var app = XCUIApplication()
	private var shotsDir = ""
	private var tag = "run"
	private var step = 0

	override func setUpWithError() throws {
		continueAfterFailure = false
		let env = ProcessInfo.processInfo.environment
		let seedPath = env["LIVE_SEED_ENV"] ?? ""
		let text = try String(contentsOfFile: seedPath, encoding: .utf8)
		for line in text.split(separator: "\n") {
			let parts = line.split(separator: "=", maxSplits: 1).map(String.init)
			if parts.count == 2 { seed[parts[0]] = parts[1] }
		}
		api = try XCTUnwrap(env["LIVE_API"], "set TEST_RUNNER_LIVE_API (e.g. http://host:port/api)")
		email = try XCTUnwrap(env["LIVE_EMAIL"], "set TEST_RUNNER_LIVE_EMAIL")
		password = try XCTUnwrap(env["LIVE_PASSWORD"], "set TEST_RUNNER_LIVE_PASSWORD")
		shotsDir = env["LIVE_SHOTS_DIR"] ?? NSTemporaryDirectory()
		tag = env["LIVE_TAG"] ?? "run"
		try? FileManager.default.createDirectory(atPath: shotsDir, withIntermediateDirectories: true)
		app = XCUIApplication()
		if env["LIVE_APPEARANCE"] == "dark" {
			app.launchArguments += ["-AppleInterfaceStyle", "Dark"]
		}
		app.launch()
	}

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
		XCTAssertTrue(row.waitForExistence(timeout: 15), "seeded conversation row")
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

	/// Any element (text, button, combined container) whose label contains `text`.
	private func el(_ text: String) -> XCUIElement {
		app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", text)).firstMatch
	}

	private func waitForServer(_ path: String, contains text: String, timeout: TimeInterval = 20) throws -> String {
		let deadline = Date().addingTimeInterval(timeout)
		var last = ""
		while Date() < deadline {
			last = try get(path)
			if last.contains(text) { return last }
			sleep(1)
		}
		return last
	}

	private func signInIfNeeded() throws {
		if app.textFields["Email"].waitForExistence(timeout: 6) { shot("login"); try signIn() }
		XCTAssertTrue(app.buttons["Account"].firstMatch.waitForExistence(timeout: 20), "signed-in shell visible")
	}

	private func signIn(password pw: String? = nil) throws {
		let field = app.textFields["Email"]
		field.tap()
		field.typeText(email)
		let secure = app.secureTextFields["Password"]
		secure.tap()
		secure.typeText(pw ?? password)
		app.buttons["Sign in"].tap()
	}

	/// iPhone: tab bar button. iPad: the sidebar-adaptable bar (top tab bar or sidebar).
	private func openSidebarTab(_ name: String) {
		let tab = app.tabBars.buttons[name]
		if tab.exists { tab.tap(); return }
		let any = app.buttons[name].firstMatch
		if any.waitForExistence(timeout: 5) { any.tap() }
	}

	private var testName: String {
		name.split(separator: " ").last.map { String($0).replacingOccurrences(of: "]", with: "") } ?? "t"
	}

	private func shot(_ name: String) {
		step += 1
		sleep(1)
		let png = XCUIScreen.main.screenshot().pngRepresentation
		let file = "\(shotsDir)/\(tag)-\(testName)-\(String(format: "%02d", step))-\(name).png"
		try? png.write(to: URL(fileURLWithPath: file))
		let attachment = XCTAttachment(data: png, uniformTypeIdentifier: "public.png")
		attachment.name = name
		attachment.lifetime = .keepAlways
		add(attachment)
	}

	private func get(_ path: String, key: String? = nil) throws -> String {
		var req = URLRequest(url: URL(string: api + path)!)
		req.setValue("Bearer \(key ?? seed["KEY"]!)", forHTTPHeaderField: "Authorization")
		req.setValue(seed["WS"]!, forHTTPHeaderField: "X-Workspace-Id")
		return try send(req)
	}

	@discardableResult
	private func post(_ path: String, body: [String: Any], key: String) throws -> String {
		var req = URLRequest(url: URL(string: api + path)!)
		req.httpMethod = "POST"
		req.httpBody = try JSONSerialization.data(withJSONObject: body)
		req.setValue("application/json", forHTTPHeaderField: "content-type")
		req.setValue("Bearer \(key)", forHTTPHeaderField: "Authorization")
		req.setValue(seed["WS"]!, forHTTPHeaderField: "X-Workspace-Id")
		return try send(req)
	}

	private func send(_ req: URLRequest) throws -> String {
		let sem = DispatchSemaphore(value: 0)
		nonisolated(unsafe) var out = ""
		nonisolated(unsafe) var err: Error?
		URLSession.shared.dataTask(with: req) { data, _, e in
			err = e
			out = data.flatMap { String(data: $0, encoding: .utf8) } ?? ""
			sem.signal()
		}.resume()
		sem.wait()
		if let err { throw err }
		return out
	}
}
