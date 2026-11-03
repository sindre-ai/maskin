import XCTest

/// Live chat flows against a REAL API. Run against a build whose `MASKIN_API_BASE_URL` points at the
/// toggleable proxy (`LIVE_PROXY_DOWN` = path of the file whose existence takes the proxy "offline");
/// `LIVE_API` is the API the test itself talks to directly, so it can verify while the app is offline.
@MainActor
final class ChatLiveTests: LiveTestCase {
	nonisolated private var downFile: String { ProcessInfo.processInfo.environment["LIVE_PROXY_DOWN"] ?? "" }

	nonisolated private func setOffline(_ offline: Bool) {
		guard !downFile.isEmpty else { return }
		if offline { FileManager.default.createFile(atPath: downFile, contents: Data()) }
		else { try? FileManager.default.removeItem(atPath: downFile) }
	}

	override func tearDownWithError() throws { setOffline(false) }

	private func actorId(_ name: String) throws -> String {
		let list = try XCTUnwrap(try json("/actors") as? [[String: Any]])
		return try XCTUnwrap(list.first { ($0["name"] as? String) == name }?["id"] as? String, "actor \(name)")
	}

	/// A fresh conversation (human + Forge + Driver) so flows never see each other's messages.
	private func makeConversation(_ label: String) throws -> (id: String, title: String) {
		let title = "XC \(label) \(Int(Date().timeIntervalSince1970) % 100000)"
		let out = try post("/conversations", body: [
			"title": title, "participant_actor_ids": [try actorId("Forge"), try actorId("Driver")],
			"initial_message": "Opening line for \(title)",
		], key: seed["KEY"]!)
		let obj = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(out.utf8)) as? [String: Any])
		return (try XCTUnwrap(obj["id"] as? String), title)
	}

	private func messages(_ id: String) throws -> [[String: Any]] {
		let any = try json("/conversations/\(id)/messages?limit=100")
		if let a = any as? [[String: Any]] { return a }
		return ((any as? [String: Any])?["messages"] as? [[String: Any]]) ?? []
	}

	private func count(_ id: String, _ text: String) throws -> Int {
		try messages(id).filter { ($0["content"] as? String) == text }.count
	}

	private func open(_ title: String) throws {
		try signInIfNeeded()
		openSidebarTab("Chats")
		let row = el(title)
		if !row.waitForExistence(timeout: 20) { shot("chat-row-missing"); dumpTree("chats"); XCTFail("row \(title) missing"); throw XCTSkip("no row") }
		row.tap()
		XCTAssertTrue(composer.waitForExistence(timeout: 10), "composer")
	}

	private var composer: XCUIElement {
		app.textFields.matching(NSPredicate(format: "placeholderValue CONTAINS 'Message' OR label CONTAINS 'Message'")).firstMatch
	}

	private func send(_ text: String) {
		composer.tap()
		composer.typeText(text)
		app.buttons["Send"].tap()
	}

	// (1) send once
	func testC1_SendAppearsExactlyOnce() throws {
		let c = try makeConversation("send")
		try open(c.title)
		shot("thread")
		let text = "Once only \(Int(Date().timeIntervalSince1970))"
		send(text)
		XCTAssertTrue(app.staticTexts[text].waitForExistence(timeout: 10), "message shown")
		XCTAssertTrue(try eventually { try count(c.id, text) >= 1 }, "persisted")
		sleep(3)
		XCTAssertEqual(try count(c.id, text), 1, "exactly one server row")
		shot("thread-sent")
	}

	// (2) offline: queued sends arrive once, in order; relaunch with a queued message
	func testC2_OfflineQueueAndRelaunch() throws {
		let c = try makeConversation("offline")
		try open(c.title)
		let stamp = Int(Date().timeIntervalSince1970)
		setOffline(true)
		sleep(2)
		shot("offline-banner")
		let a = "Queued A \(stamp)", b = "Queued B \(stamp)"
		send(a); sleep(1); send(b)
		XCTAssertTrue(app.staticTexts[a].waitForExistence(timeout: 10), "optimistic A")
		sleep(2)
		shot("offline-queued")
		XCTAssertEqual(try count(c.id, a) + count(c.id, b), 0, "nothing reached the server while offline")
		setOffline(false)
		XCTAssertTrue(try eventually(timeout: 60) { try count(c.id, a) == 1 && count(c.id, b) == 1 }, "both delivered")
		sleep(3)
		XCTAssertEqual(try count(c.id, a), 1); XCTAssertEqual(try count(c.id, b), 1)
		let rows = try messages(c.id)
		func idx(_ t: String) -> Int { rows.firstIndex { ($0["content"] as? String) == t } ?? -1 }
		let ids = rows.compactMap { $0["id"] as? Int }
		let ordered = ids == ids.sorted() ? idx(a) < idx(b) : idx(a) > idx(b)
		XCTAssertTrue(ordered, "A before B")
		shot("offline-delivered")
		// Kill with a queued message, relaunch, it still sends exactly once.
		let cText = "Queued C \(stamp)"
		setOffline(true); sleep(2)
		send(cText); sleep(2)
		app.terminate()
		setOffline(false)
		app.launch()
		XCTAssertTrue(try eventually(timeout: 60) { try count(c.id, cText) == 1 }, "queued across relaunch")
		sleep(4)
		XCTAssertEqual(try count(c.id, cText), 1, "sent once, not duplicated")
	}

	// (3) live SSE message + read state
	func testC3_LiveMessageAndReadState() throws {
		let c = try makeConversation("live")
		let other = try makeConversation("other")
		try open(c.title)
		let live = "Live from Forge \(Int(Date().timeIntervalSince1970))"
		try post("/conversations/\(c.id)/messages", body: ["content": live], key: seed["AKEY"]!)
		XCTAssertTrue(app.staticTexts[live].waitForExistence(timeout: 15), "SSE message appears")
		shot("live-message")
		XCTAssertTrue(try eventually { try unread(c.id) == 0 }, "open thread is read server-side")
		// A message in the other chat while this one is open: unread there.
		try post("/conversations/\(other.id)/messages", body: ["content": "ping other"], key: seed["AKEY"]!)
		app.navigationBars.buttons.element(boundBy: 0).tap()
		XCTAssertTrue(el(other.title).waitForExistence(timeout: 10))
		shot("list-unread")
		let row = el(other.title)
		XCTAssertTrue(row.label.contains("unread"), "list row shows unread: \(row.label)")
		XCTAssertGreaterThan(try unread(other.id), 0)
		row.tap(); _ = composer.waitForExistence(timeout: 10)
		XCTAssertTrue(try eventually { try unread(other.id) == 0 }, "read after opening")
	}

	private func unread(_ id: String) throws -> Int {
		let any = try json("/conversations?limit=100")
		let rows = (any as? [String: Any])?["conversations"] as? [[String: Any]] ?? []
		return rows.first { ($0["id"] as? String) == id }?["unread_count"] as? Int ?? -1
	}

	// (5) mention
	func testC5_Mention() throws {
		let c = try makeConversation("mention")
		try open(c.title)
		composer.tap()
		composer.typeText("@For")
		let pick = app.buttons["Mention Forge"]
		XCTAssertTrue(pick.waitForExistence(timeout: 5), "mention picker")
		shot("mention-picker")
		pick.tap()
		composer.typeText("status please")
		shot("mention-chip")
		app.buttons["Send"].tap()
		let forge = try actorId("Forge")
		XCTAssertTrue(try eventually {
			try messages(c.id).contains { m in
				((m["metadata"] as? [String: Any])?["mentions"] as? [Any])?.contains { "\($0)".contains(forge) } == true
			}
		}, "metadata.mentions carries Forge")
		shot("mention-sent")
	}

	// (4) attachment: the file importer is a system sheet; cover as far as is automatable
	func testC4_AttachmentMenu() throws {
		let c = try makeConversation("attach")
		try open(c.title)
		app.buttons["Add photo, file or mention"].tap()
		shot("attach-menu")
		XCTAssertTrue(app.buttons["Photo"].exists && app.buttons["File"].exists, "photo and file entries")
		app.buttons["File"].tap()
		sleep(2)
		shot("attach-file-picker")
	}

	// (7) rename + remove participant
	func testC7_RenameAndRemove() throws {
		let c = try makeConversation("rename")
		try open(c.title)
		app.buttons["Conversation"].tap()
		app.buttons["Rename"].tap()
		let field = app.textFields["Title"]
		XCTAssertTrue(field.waitForExistence(timeout: 5), "rename alert")
		let renamed = "Renamed \(Int(Date().timeIntervalSince1970) % 100000)"
		field.tap()
		field.press(forDuration: 1.0)
		if app.menuItems["Select All"].waitForExistence(timeout: 2) { app.menuItems["Select All"].tap() }
		field.typeText(renamed)
		shot("rename-alert")
		app.buttons["Save"].tap()
		let convs = { () throws -> [[String: Any]] in ((try self.json("/conversations?limit=100") as? [String: Any])?["conversations"] as? [[String: Any]]) ?? [] }
		XCTAssertTrue(try eventually { try convs().contains { ($0["id"] as? String) == c.id && ($0["title"] as? String) == renamed } }, "title persisted")
		app.buttons["Conversation"].tap()
		app.buttons["People"].tap()
		let driver = el("Driver")
		XCTAssertTrue(driver.waitForExistence(timeout: 10), "participants list")
		shot("participants")
		driver.swipeLeft()
		app.buttons["Remove"].firstMatch.tap()
		shot("remove-confirm")
		app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Remove Driver'")).firstMatch.tap()
		let did = try actorId("Driver")
		XCTAssertTrue(try eventually {
			let row = try convs().first { ($0["id"] as? String) == c.id }
			let parts = row?["participants"] as? [[String: Any]] ?? []
			return !parts.contains { ($0["actorId"] as? String) == did && ($0["leftAt"] == nil || $0["leftAt"] is NSNull) }
		}, "Driver left the conversation server-side")
		shot("participants-after")
	}

	// (8) cached list/thread on relaunch with the API unreachable
	func testC8_CachedWhileOffline() throws {
		let c = try makeConversation("cache")
		try open(c.title)
		sleep(3)
		app.terminate()
		setOffline(true)
		app.launch()
		openSidebarTab("Chats")
		let t0 = Date()
		XCTAssertTrue(el(c.title).waitForExistence(timeout: 10), "cached list row while offline")
		shot("cached-list-offline")
		el(c.title).tap()
		XCTAssertTrue(el("Opening line").waitForExistence(timeout: 10), "cached thread while offline (\(Date().timeIntervalSince(t0))s)")
		shot("cached-thread-offline")
	}
}
