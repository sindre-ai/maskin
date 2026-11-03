import XCTest

/// Walks the main iPhone screens in the demo workspace and writes a PNG of each to
/// `$SCREEN_TOUR_DIR` (default /tmp/screen-tour), so they can be compared with the design.
/// Best effort: a screen that cannot be reached is skipped and logged, never a failure.
///
///   DEMO_PERF=1 PORT=3010 node scripts/demo-server/server.mjs
///   SCREEN_TOUR_DIR=/tmp/tour xcodebuild ... MASKIN_API_BASE_URL=http://localhost:3010 test -only-testing:MaskinUITests/ScreenTourTests
@MainActor
final class ScreenTourTests: XCTestCase {
	private static let session =
		#"{"apiKey":"ank_demo","actorId":"00000000-0000-4000-8000-000000000002","name":"Sindre Aasen","email":"sindre@northwind.example","workspaceId":"00000000-0000-4000-8000-000000000001"}"#

	private var app = XCUIApplication()
	private let dir = ProcessInfo.processInfo.environment["SCREEN_TOUR_DIR"] ?? "/tmp/screen-tour"
	private var skipped: [String] = []

	override func setUpWithError() throws {
		continueAfterFailure = true
		try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
		app = XCUIApplication()
		app.launchEnvironment["MASKIN_DEMO_SESSION"] = Self.session
		app.launch()
		XCTAssertTrue(app.tabBars.buttons["For you"].waitForExistence(timeout: 30), "signed-in shell")
		sleep(4)
	}

	private func shot(_ name: String) {
		let png = XCUIScreen.main.screenshot().pngRepresentation
		try? png.write(to: URL(fileURLWithPath: "\(dir)/\(name).png"))
	}

	@discardableResult
	private func tap(_ element: XCUIElement, _ label: String, wait: TimeInterval = 6) -> Bool {
		guard element.waitForExistence(timeout: wait) else {
			skipped.append(label)
			return false
		}
		if element.isHittable { element.tap() } else { element.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap() }
		sleep(3)
		return true
	}

	private func back() {
		let from = app.coordinate(withNormalizedOffset: CGVector(dx: 0.0, dy: 0.5))
		from.press(forDuration: 0.1, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.9, dy: 0.5)))
		sleep(2)
	}

	/// Opens a maskin:// link in the running app (iOS 17+).
	private func link(_ path: String, _ name: String) {
		app.terminate()
		app.launch()
		_ = app.tabBars.buttons["For you"].waitForExistence(timeout: 30)
		sleep(3)
		XCUIDevice.shared.system.open(URL(string: "maskin://00000000-0000-4000-8000-000000000001\(path)")!)
		sleep(7)
		shot(name)
	}

	private func relaunch() {
		app.terminate()
		app.launch()
		_ = app.tabBars.buttons["For you"].waitForExistence(timeout: 30)
		sleep(3)
	}

	private func close() {
		for label in ["Done", "Close", "Cancel"] where app.buttons[label].exists && app.buttons[label].isHittable {
			app.buttons[label].tap()
			sleep(1)
			return
		}
		app.swipeDown(velocity: .fast)
		sleep(1)
	}

	func testTour() throws {
		// Tabs
		shot("01-foryou")
		app.swipeUp()
		sleep(1)
		shot("01b-foryou-scrolled")
		app.swipeDown()

		if tap(app.tabBars.buttons["Chats"], "chats-tab") {
			shot("02-chats")
			let row = app.staticTexts["Brand shoot"].firstMatch
			if tap(row, "chat-thread") {
				shot("03-chat-thread")
				back()
			}
		}
		if tap(app.tabBars.buttons["Flows"], "flows-tab") {
			shot("04-flows")
			let cell = app.cells.firstMatch
			if tap(cell, "flow-detail") {
				shot("05-flow-detail")
				back()
			}
		}
		if tap(app.tabBars.buttons["Items"], "items-tab") {
			shot("06-items")
			let cell = app.cells.firstMatch
			if tap(cell, "item-detail") {
				shot("07-item-detail")
				back()
			}
		}

		// Search
		app.tabBars.buttons["For you"].tap()
		sleep(1)
		let search = app.buttons["Search"].firstMatch
		if tap(search, "search") {
			shot("08-search")
			close()
		}

		// Display sheet and profile sheet from the top bar
		let display = app.buttons["Display"].firstMatch
		if tap(display, "display-sheet") {
			shot("09-display-sheet")
			close()
		}
		let profile = app.buttons.matching(NSPredicate(format: "label CONTAINS[c] 'profile' OR label CONTAINS[c] 'account' OR label == 'S'")).firstMatch
		if tap(profile, "profile-sheet") {
			shot("10-profile-sheet")
			for (idx, title) in ["Agents", "Settings", "Members", "Integrations", "Billing", "Triggers", "Files"].enumerated() {
				let row = app.buttons[title].firstMatch.exists ? app.buttons[title].firstMatch : app.staticTexts[title].firstMatch
				if tap(row, "profile-\(title)", wait: 3) {
					shot(String(format: "11-%02d-%@", idx, title.lowercased()))
					back()
				}
			}
		}
		// Item detail, Display sheet, thread (long wait), agents via Members
		relaunch()
		if tap(app.tabBars.buttons["Items"], "items-tab2") {
			if tap(app.staticTexts["Q4 webinar"].firstMatch, "item-bet") { sleep(3); shot("14-item-bet"); back() }
			if tap(app.staticTexts["Contoso renewal terms"].firstMatch, "item-task") { sleep(3); shot("15-item-task"); back() }
			if tap(app.staticTexts["Northwind renewal risk"].firstMatch, "item-insight") { sleep(3); shot("16-item-insight"); back() }
			let display = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Display'")).firstMatch
			if tap(display, "display-items") { shot("09-display-sheet"); close() }
		}
		relaunch()
		if tap(app.tabBars.buttons["Chats"], "chats-tab2") {
			if tap(app.staticTexts["Brand shoot"].firstMatch, "chat-thread2") { sleep(10); shot("03-chat-thread"); }
		}
		relaunch()
		let profile2 = app.buttons.matching(NSPredicate(format: "label CONTAINS[c] 'profile' OR label CONTAINS[c] 'account' OR label == 'S'")).firstMatch
		if tap(profile2, "profile2") {
			if tap(app.staticTexts["Members"].firstMatch, "members2") {
				sleep(3)
				shot("12-members-agents")
				if tap(app.staticTexts["Outreach"].firstMatch, "agent-detail") {
					sleep(4); shot("13-agent-detail")
					let more = app.buttons.matching(NSPredicate(format: "label CONTAINS[c] 'more' OR label CONTAINS[c] 'actions'")).firstMatch
					if tap(more, "agent-menu", wait: 3) { shot("13b-agent-menu"); app.swipeDown(); sleep(1) }
				}
			}
		}
		relaunch()
		let profile3 = app.buttons.matching(NSPredicate(format: "label CONTAINS[c] 'profile' OR label CONTAINS[c] 'account' OR label == 'S'")).firstMatch
		if tap(profile3, "profile3") {
			if tap(app.staticTexts["Triggers"].firstMatch, "triggers3") {
				sleep(3); shot("17-triggers-list")
				if tap(app.staticTexts["Review new tasks"].firstMatch, "trigger-event") { sleep(3); shot("18-trigger-event"); back() }
				if tap(app.staticTexts["Monday pipeline review"].firstMatch, "trigger-cron") { sleep(3); shot("19-trigger-cron"); back() }
				let add = app.buttons.matching(NSPredicate(format: "label CONTAINS[c] 'new trigger' OR label CONTAINS[c] 'add'")).firstMatch
				if tap(add, "trigger-new", wait: 3) { shot("20-trigger-new") }
			}
		}
		try "skipped: \(skipped.joined(separator: ", "))\n".write(toFile: "\(dir)/skipped.txt", atomically: true, encoding: .utf8)
	}

	/// Live from For you, and Reply in thread from a message: does each action do anything?
	func testLiveAndThread() throws {
		if app.buttons["Not now"].waitForExistence(timeout: 6) { app.buttons["Not now"].tap(); sleep(2) }
		if tap(app.tabBars.buttons["Chats"], "chats") {
			sleep(8); shot("30-chats-list")
			if tap(app.staticTexts["Chief of Staff"].firstMatch, "thread", wait: 15) {
				sleep(6)
				shot("31-thread-open")
				let msg = app.staticTexts["Why not all 47 contacts?"].firstMatch
				if msg.waitForExistence(timeout: 8) {
					msg.press(forDuration: 1.2); sleep(2); shot("32-message-menu")
					let reply = app.buttons.matching(NSPredicate(format: "label CONTAINS[c] 'thread'")).firstMatch
					if tap(reply, "reply-in-thread", wait: 3) { sleep(4); shot("33-thread-reply") }
				} else { skipped.append("no-message") }
			}
		}
		try "skipped: \(skipped.joined(separator: ", "))\n".write(toFile: "\(dir)/skipped-live.txt", atomically: true, encoding: .utf8)
	}
}
