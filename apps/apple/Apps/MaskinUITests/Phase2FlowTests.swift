import XCTest

/// Live walk of the phase-2 screens (Loops, Agents, Search, Settings) against a REAL API.
/// Discovers its data by GET (no ids baked in): loops and triggers come from the workspace's
/// default template, "Forge" from `seed.sh`, files from `seed2.sh` (flows skip with a message
/// when absent). Every write is verified by reading it back from the API.
@MainActor
final class Phase2FlowTests: LiveTestCase {
	private func list(_ path: String, key: String = "") throws -> [[String: Any]] {
		let any = try json(path)
		if let a = any as? [[String: Any]] { return a }
		if let d = any as? [String: Any] { for v in d.values { if let a = v as? [[String: Any]] { return a } } }
		return []
	}

	private func trigger(named name: String) throws -> [String: Any]? {
		try list("/triggers").first { ($0["name"] as? String) == name }
	}

	// MARK: Loops

	func test10_LoopsAndTriggers() throws {
		try signInIfNeeded()
		openSidebarTab("Loops")
		let loops = try list("/loops")
		let name = try XCTUnwrap(loops.first?["name"] as? String)
		let row = el(name)
		if !row.waitForExistence(timeout: 15) { shot("loops-missing"); dumpTree("loops"); XCTFail("loop row '\(name)' missing"); return }
		shot("loops-list")
		row.tap()
		XCTAssertTrue(el("Steps").waitForExistence(timeout: 15), "loop detail shows Steps")
		sleep(2)
		shot("loop-detail")
		// First step opens its trigger.
		let step = app.buttons.matching(NSPredicate(format: "label CONTAINS 'Fires'")).firstMatch
		if step.waitForExistence(timeout: 5) { scrollTo(step); step.tap() }
		else { shot("loop-no-steps") }
		// Trigger detail (via step, else via the Triggers switch).
		var toggle = app.switches["Enabled"].firstMatch
		if !toggle.waitForExistence(timeout: 8) {
			let triggersTab = app.segmentedControls.buttons["Triggers"]
			if triggersTab.exists { triggersTab.tap() }
			let t = try XCTUnwrap(try trigger(named: "Forge nightly sweep") ?? list("/triggers").first)
			let tname = try XCTUnwrap(t["name"] as? String)
			XCTAssertTrue(el(tname).waitForExistence(timeout: 10), "trigger row")
			el(tname).tap()
			toggle = app.switches["Enabled"].firstMatch
			XCTAssertTrue(toggle.waitForExistence(timeout: 10), "trigger detail toggle")
		}
		shot("trigger-detail")
		let title = app.navigationBars.element(boundBy: 0).identifier
		let all = try list("/triggers")
		let target = all.first { ($0["name"] as? String) == title } ?? all.first
		let id = try XCTUnwrap(target?["id"] as? String)
		let before = (target?["enabled"] as? Bool) ?? true
		toggle.tap()
		let flipped = try eventually { (try list("/triggers").first { ($0["id"] as? String) == id }?["enabled"] as? Bool) == !before }
		shot("trigger-toggled")
		XCTAssertTrue(flipped, "trigger enabled flag persisted server-side as \(!before)")
		toggle.tap()
		let restored = try eventually { (try list("/triggers").first { ($0["id"] as? String) == id }?["enabled"] as? Bool) == before }
		XCTAssertTrue(restored, "trigger restored")
		shot("trigger-restored")
	}

	// MARK: Agents

	func test11_Agents() throws {
		try signInIfNeeded()
		openSidebarTab("Agents")
		let row = el("Forge")
		if !row.waitForExistence(timeout: 15) { shot("agents-missing"); dumpTree("agents"); XCTFail("Forge row missing"); return }
		shot("agents-list")
		row.tap()
		XCTAssertTrue(el("Recent sessions").waitForExistence(timeout: 15), "agent detail")
		sleep(2)
		shot("agent-detail")
		let forge = try XCTUnwrap(try list("/actors").first { ($0["name"] as? String) == "Forge" })
		let forgeId = try XCTUnwrap(forge["id"] as? String)
		let sessionsBefore = try list("/sessions").filter { ($0["actorId"] as? String) == forgeId }.count
		// Reset is gated by a confirmation; cancel it.
		let reset = app.buttons["Reset"].firstMatch
		if reset.waitForExistence(timeout: 3) {
			reset.tap()
			XCTAssertTrue(el("factory defaults").waitForExistence(timeout: 5), "reset confirmation")
			shot("agent-reset-confirm")
			let cancel = app.buttons["Cancel"].firstMatch
			if cancel.exists { cancel.tap() } else { app.tap() }
		}
		let run = app.buttons.matching(NSPredicate(format: "label CONTAINS 'Run now' OR label CONTAINS 'Resume'")).firstMatch
		XCTAssertTrue(run.waitForExistence(timeout: 5), "run button")
		run.tap()
		let field = app.textFields["What should it do?"].firstMatch
		XCTAssertTrue(field.waitForExistence(timeout: 5), "run sheet")
		field.tap()
		field.typeText("XCUITest run \(Int(Date().timeIntervalSince1970))")
		shot("agent-run-sheet")
		app.buttons["Run"].tap()
		let started = try eventually { try list("/sessions").filter { ($0["actorId"] as? String) == forgeId }.count > sessionsBefore }
		shot("agent-after-run")
		XCTAssertTrue(started, "a session was created for Forge server-side")
	}

	// MARK: Search

	func test12_Search() throws {
		try signInIfNeeded()
		let tab = app.tabBars.buttons["Search"].exists ? app.tabBars.buttons["Search"] : app.buttons["Search"].firstMatch
		XCTAssertTrue(tab.waitForExistence(timeout: 10), "search tab")
		tab.tap()
		shot("search-empty")
		let field = app.searchFields.firstMatch
		XCTAssertTrue(field.waitForExistence(timeout: 10), "search field")
		field.tap()
		field.typeText("iOS")
		let result = el("Ship a native iOS app")
		XCTAssertTrue(result.waitForExistence(timeout: 15), "object result")
		shot("search-results")
		app.keyboards.buttons["search"].firstMatch.tap()
		result.tap()
		XCTAssertTrue(app.navigationBars["Bet"].waitForExistence(timeout: 10), "object sheet opened")
		XCTAssertTrue(el("Offline outbox").waitForExistence(timeout: 10), "object markdown body")
		shot("search-object-sheet")
		let done = app.buttons["Done"].firstMatch
		if done.exists { done.tap() } else { app.swipeDown() }
		// File result.
		guard let file = try list("/files").first(where: { ($0["name"] as? String) == "launch-notes.md" }) else {
			shot("search-no-file-seed"); XCTFail("launch-notes.md not seeded (run seed2.sh)"); return
		}
		_ = file
		let f = app.searchFields.firstMatch
		f.tap()
		if let clear = f.buttons["Clear text"].firstMatch as XCUIElement?, clear.exists { clear.tap() }
		f.typeText("launch-notes")
		XCTAssertTrue(el("launch-notes").waitForExistence(timeout: 15), "file result")
		shot("search-file-results")
		el("launch-notes").tap()
		XCTAssertTrue(el("beta checklist").waitForExistence(timeout: 10), "markdown rendered")
		XCTAssertFalse(app.staticTexts["# Launch notes"].exists, "markdown heading not shown as raw source")
		shot("search-file-sheet")
	}

	// MARK: Settings

	private func openSettings() {
		let account = app.buttons["Account"].firstMatch
		XCTAssertTrue(account.waitForExistence(timeout: 10), "account menu")
		account.tap()
		app.buttons["Settings"].firstMatch.tap()
		XCTAssertTrue(app.navigationBars["Settings"].waitForExistence(timeout: 10), "settings sheet")
	}

	func test13_SettingsProfileMembersIntegrationsKey() throws {
		try signInIfNeeded()
		openSettings()
		shot("settings")
		let original = try XCTUnwrap((try json("/actors/\(seed["ME"]!)") as? [String: Any])?["name"] as? String)
		// Profile
		app.buttons.matching(NSPredicate(format: "label CONTAINS 'Profile'")).firstMatch.tap()
		let nameField = app.textFields["Your name"]
		XCTAssertTrue(nameField.waitForExistence(timeout: 5), "name field")
		let newName = "Live Tester \(Int(Date().timeIntervalSince1970) % 1000)"
		nameField.tap()
		nameField.press(forDuration: 1.0)
		if app.menuItems["Select All"].waitForExistence(timeout: 2) { app.menuItems["Select All"].tap() }
		nameField.typeText(newName)
		app.buttons["Save"].tap()
		let saved = try eventually { ((try json("/actors/\(seed["ME"]!)") as? [String: Any])?["name"] as? String) == newName }
		shot("settings-profile-saved")
		XCTAssertTrue(saved, "profile name persisted server-side")
		try patch("/actors/\(seed["ME"]!)", body: ["name": original])
		app.navigationBars.buttons.element(boundBy: 0).tap()
		// Members
		app.buttons.matching(NSPredicate(format: "label CONTAINS 'Members'")).firstMatch.tap()
		XCTAssertTrue(app.navigationBars["Members"].waitForExistence(timeout: 5))
		XCTAssertTrue(el("Forge").waitForExistence(timeout: 10), "members list shows names")
		shot("settings-members")
		app.navigationBars.buttons.element(boundBy: 0).tap()
		// Integrations
		app.buttons.matching(NSPredicate(format: "label CONTAINS 'Integrations'")).firstMatch.tap()
		XCTAssertTrue(app.navigationBars["Integrations"].waitForExistence(timeout: 5))
		sleep(3)
		shot("settings-integrations")
		app.navigationBars.buttons.element(boundBy: 0).tap()
		// API key: masked by default; regenerate is gated.
		app.buttons.matching(NSPredicate(format: "label CONTAINS 'API key'")).firstMatch.tap()
		XCTAssertTrue(app.navigationBars["API key"].waitForExistence(timeout: 5))
		XCTAssertFalse(el("ank_").exists, "no key material on screen by default")
		let regen = app.buttons["Regenerate API key"]
		if regen.exists && regen.isEnabled {
			regen.tap()
			XCTAssertTrue(el("Regenerate your API key?").waitForExistence(timeout: 5), "confirmation before regenerating")
			shot("settings-apikey-confirm")
			let cancel = app.buttons["Cancel"].firstMatch
			if cancel.exists { cancel.tap() } else { app.tap() }
		} else {
			shot("settings-apikey-disabled")
		}
		let keyAfter = try json("/actors/\(seed["ME"]!)")
		XCTAssertNotNil(keyAfter, "seed key still valid after cancelled regenerate")
	}

	func test14_SignOutFromSettings() throws {
		try signInIfNeeded()
		openSettings()
		let signOut = app.buttons["Sign out"].firstMatch
		scrollTo(signOut)
		shot("settings-about")
		signOut.tap()
		XCTAssertTrue(el("Sign out of Maskin?").waitForExistence(timeout: 5), "confirmation")
		shot("settings-signout-confirm")
		app.buttons.matching(NSPredicate(format: "label == 'Sign out'")).allElementsBoundByIndex.last?.tap()
		XCTAssertTrue(app.textFields["Email"].waitForExistence(timeout: 15), "back at login")
		shot("settings-signed-out")
		try signIn()
		XCTAssertTrue(app.buttons["Account"].firstMatch.waitForExistence(timeout: 20), "signed in again")
	}

	/// Regenerate against a throwaway user so the harness's own key is never rotated.
	func testZ_RegenerateKeyThrowaway() throws {
		let stamp = Int(Date().timeIntervalSince1970)
		let mail = "throwaway\(stamp)@maskin.test"
		// A fresh random password per run; this account exists only for the duration of the test.
		let password = "pw-\(UUID().uuidString)"
		let signup = try post("/actors", body: ["type": "human", "name": "Throwaway", "email": mail, "password": password], key: "")
		let created = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(signup.utf8)) as? [String: Any])
		let oldKey = try XCTUnwrap(created["api_key"] as? String)
		if app.buttons["Account"].waitForExistence(timeout: 5) {
			app.buttons["Account"].tap(); app.buttons["Sign out"].firstMatch.tap()
			confirmSignOutDialog()
		}
		let field = app.textFields["Email"]
		XCTAssertTrue(field.waitForExistence(timeout: 10), "login")
		field.tap(); field.typeText(mail)
		let pw = app.secureTextFields["Password"]; pw.tap(); pw.typeText(password)
		app.buttons["Sign in"].tap()
		XCTAssertTrue(app.buttons["Account"].firstMatch.waitForExistence(timeout: 20), "throwaway signed in")
		openSettings()
		app.buttons.matching(NSPredicate(format: "label CONTAINS 'API key'")).firstMatch.tap()
		let regen = app.buttons["Regenerate API key"]
		XCTAssertTrue(regen.waitForExistence(timeout: 5))
		guard regen.isEnabled else { shot("throwaway-regen-disabled"); XCTFail("Regenerate disabled"); return }
		regen.tap()
		shot("throwaway-regen-confirm")
		app.buttons["Regenerate and sign out other devices"].tap()
		XCTAssertTrue(el("Shown only now").waitForExistence(timeout: 15), "new key shown once")
		XCTAssertFalse(el(oldKey).exists, "old key not displayed")
		shot("throwaway-regen-shown")
		// Old key no longer authenticates.
		let wsId = try XCTUnwrap(created["workspace_id"] as? String)
		var req = URLRequest(url: URL(string: api + "/actors")!)
		req.setValue("Bearer \(oldKey)", forHTTPHeaderField: "Authorization")
		req.setValue(wsId, forHTTPHeaderField: "X-Workspace-Id")
		let body = try send(req)
		XCTAssertTrue(body.contains("error") || body.contains("UNAUTH"), "old key rejected: \(body.prefix(120))")
		// Leave the app signed out so later runs start clean.
		app.navigationBars.buttons.element(boundBy: 0).tap()
		app.buttons["Done"].firstMatch.tap()
		if app.buttons["Account"].waitForExistence(timeout: 5) { app.buttons["Account"].tap(); app.buttons["Sign out"].firstMatch.tap(); confirmSignOutDialog() }
	}
}
