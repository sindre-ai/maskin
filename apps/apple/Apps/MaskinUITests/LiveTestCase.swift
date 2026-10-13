import XCTest

/// Shared plumbing for the live (real-API) UI flows: env, seed ids, screenshots, REST helpers.
/// Env (pass as `TEST_RUNNER_<NAME>`): `LIVE_API`, `LIVE_EMAIL`, `LIVE_PASSWORD`, `LIVE_SEED_ENV`,
/// `LIVE_SHOTS_DIR`, `LIVE_APPEARANCE`, `LIVE_TAG`.
@MainActor
class LiveTestCase: XCTestCase {
	// No defaults on purpose: credentials and API origin come from the environment.
	var api = ""
	var email = ""
	var password = ""
	var seed: [String: String] = [:]
	var app = XCUIApplication()
	var shotsDir = ""
	var tag = "run"
	var step = 0

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

// MARK: Helpers

	/// Any element (text, button, combined container) whose label contains `text`.
	func el(_ text: String) -> XCUIElement {
		app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", text)).firstMatch
	}

	func waitForServer(_ path: String, contains text: String, timeout: TimeInterval = 20) throws -> String {
		let deadline = Date().addingTimeInterval(timeout)
		var last = ""
		while Date() < deadline {
			last = try get(path)
			if last.contains(text) { return last }
			sleep(1)
		}
		return last
	}

	func signInIfNeeded() throws {
		if app.textFields["Email"].waitForExistence(timeout: 6) { shot("login"); try signIn() }
		if !app.buttons["Account"].firstMatch.waitForExistence(timeout: 30) {
			shot("signin-failed"); dumpTree("signin-failed")
			XCTFail("signed-in shell visible")
		}
	}

	/// Types into a field once it really has keyboard focus (a tap can be swallowed while the keyboard
	/// is still animating, especially on a loaded machine).
	private func type(_ text: String, into field: XCUIElement) {
		for _ in 0..<4 {
			field.tap()
			let focused = NSPredicate(format: "hasKeyboardFocus == true")
			let exp = XCTNSPredicateExpectation(predicate: focused, object: field)
			if XCTWaiter().wait(for: [exp], timeout: 4) == .completed { break }
		}
		field.typeText(text)
	}

	func signIn(password pw: String? = nil) throws {
		type(email, into: app.textFields["Email"])
		type(pw ?? password, into: app.secureTextFields["Password"])
		app.buttons["Sign in"].tap()
	}

	/// iPhone: tab bar button. iPad: the sidebar-adaptable bar (top tab bar or sidebar).
	func openSidebarTab(_ name: String) {
		let tab = app.tabBars.buttons[name]
		if tab.exists { tab.tap(); return }
		let any = app.buttons[name].firstMatch
		if any.waitForExistence(timeout: 5) { any.tap() }
	}

	var testName: String {
		name.split(separator: " ").last.map { String($0).replacingOccurrences(of: "]", with: "") } ?? "t"
	}

	func shot(_ name: String) {
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

	func get(_ path: String, key: String? = nil) throws -> String {
		var req = URLRequest(url: URL(string: api + path)!)
		req.setValue("Bearer \(key ?? seed["KEY"]!)", forHTTPHeaderField: "Authorization")
		req.setValue(seed["WS"]!, forHTTPHeaderField: "X-Workspace-Id")
		return try send(req)
	}

	@discardableResult
	func post(_ path: String, body: [String: Any], key: String) throws -> String {
		var req = URLRequest(url: URL(string: api + path)!)
		req.httpMethod = "POST"
		req.httpBody = try JSONSerialization.data(withJSONObject: body)
		req.setValue("application/json", forHTTPHeaderField: "content-type")
		req.setValue("Bearer \(key)", forHTTPHeaderField: "Authorization")
		req.setValue(seed["WS"]!, forHTTPHeaderField: "X-Workspace-Id")
		return try send(req)
	}

	func send(_ req: URLRequest) throws -> String {
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

	/// GET parsed as JSON (`[Any]` or `[String: Any]`).
	func json(_ path: String, key: String? = nil) throws -> Any {
		let text = try get(path, key: key)
		return try JSONSerialization.jsonObject(with: Data(text.utf8))
	}

	@discardableResult
	func patch(_ path: String, body: [String: Any]) throws -> String {
		var req = URLRequest(url: URL(string: api + path)!)
		req.httpMethod = "PATCH"
		req.httpBody = try JSONSerialization.data(withJSONObject: body)
		req.setValue("application/json", forHTTPHeaderField: "content-type")
		req.setValue("Bearer \(seed["KEY"]!)", forHTTPHeaderField: "Authorization")
		req.setValue(seed["WS"]!, forHTTPHeaderField: "X-Workspace-Id")
		return try send(req)
	}

	/// Polls until `check` holds (verify-by-query after a UI write).
	func eventually(timeout: TimeInterval = 15, _ check: () throws -> Bool) rethrows -> Bool {
		let deadline = Date().addingTimeInterval(timeout)
		while Date() < deadline {
			if try check() { return true }
			sleep(1)
		}
		return try check()
	}

	/// Scrolls the front-most scroll container until `element` is hittable (max 6 swipes).
	func scrollTo(_ element: XCUIElement) {
		var n = 0
		while !element.isHittable && n < 6 { app.swipeUp(); n += 1 }
	}

	func dumpTree(_ name: String) {
		try? app.debugDescription.write(toFile: "\(shotsDir)/\(tag)-\(name)-tree.txt", atomically: true, encoding: .utf8)
	}
}


extension LiveTestCase {
	/// The account menu's "Sign out" asks first (queued writes are discarded on sign-out): tap the
	/// destructive button in the confirmation dialog, the last "Sign out" button on screen.
	func confirmSignOutDialog() {
		let dialogButtons = app.buttons.matching(NSPredicate(format: "label == 'Sign out'"))
		_ = dialogButtons.firstMatch.waitForExistence(timeout: 5)
		dialogButtons.allElementsBoundByIndex.last?.tap()
	}
}
