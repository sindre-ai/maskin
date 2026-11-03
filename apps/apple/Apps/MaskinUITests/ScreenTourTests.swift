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
		sleep(2)
		return true
	}

	private func back() {
		let nav = app.navigationBars.buttons.firstMatch
		if nav.exists, nav.isHittable { nav.tap() } else { app.swipeRight() }
		sleep(1)
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
		try "skipped: \(skipped.joined(separator: ", "))\n".write(toFile: "\(dir)/skipped.txt", atomically: true, encoding: .utf8)
	}
}
