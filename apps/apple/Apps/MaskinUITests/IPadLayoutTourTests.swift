import XCTest

/// The four root screens on an iPad (For you, Chats, Flows, Items) in one orientation, written as
/// PNGs to `$SCREEN_TOUR_DIR`, so the one-navigation layout can be checked by eye. Run by
/// `.github/workflows/apple-ipad-layout-screenshots.yml`; it is not part of the must-keep run.
///
/// `$SCREEN_TOUR_ORIENTATION` is `portrait` (default) or `landscape`. The runner only sees
/// `TEST_RUNNER_`-prefixed variables, and strips the prefix, like in `ScreenTourTests`.
///
/// Best effort: a screen that cannot be reached is skipped and logged in `skipped-<orientation>.txt`,
/// and a shot is only saved after a text that belongs to that screen is on it.
@MainActor
final class IPadLayoutTourTests: XCTestCase {
	private static let session =
		#"{"apiKey":"ank_demo","actorId":"00000000-0000-4000-8000-000000000002","name":"Sindre Aasen","email":"sindre@northwind.example","workspaceId":"00000000-0000-4000-8000-000000000001"}"#

	private var app = XCUIApplication()
	private let dir = ProcessInfo.processInfo.environment["SCREEN_TOUR_DIR"] ?? "/tmp/ipad-layout"
	private let orientation = ProcessInfo.processInfo.environment["SCREEN_TOUR_ORIENTATION"] ?? "portrait"
	private var skipped: [String] = []

	override func setUp() async throws {
		continueAfterFailure = true
		try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
	}

	override func tearDown() async throws {
		try? "skipped: \(skipped.joined(separator: ", "))\n"
			.write(toFile: "\(dir)/skipped-\(orientation).txt", atomically: true, encoding: .utf8)
	}

	// MARK: Helpers

	private func launch() {
		app.terminate()
		app = XCUIApplication()
		app.launchEnvironment["MASKIN_DEMO_SESSION"] = Self.session
		app.launch()
		XCUIDevice.shared.orientation = orientation == "landscape" ? .landscapeLeft : .portrait
		sleep(2)
		XCTAssertTrue(tab("For you").waitForExistence(timeout: 30), "signed-in shell")
		sleep(3)
		dismissNotificationPrompt(wait: 3)
	}

	/// The iPad's tab bar is a bar of destinations at the top; find it as a tab bar button first and
	/// as a plain button second, so a change in how the system exposes it does not hide the screen.
	private func tab(_ title: String) -> XCUIElement {
		let inBar = app.tabBars.buttons[title].firstMatch
		return inBar.exists ? inBar : app.buttons[title].firstMatch
	}

	private func dismissNotificationPrompt(wait: TimeInterval) {
		let notNow = app.buttons["Not now"].firstMatch
		guard notNow.waitForExistence(timeout: wait) else { return }
		notNow.tap()
		sleep(1)
	}

	private func appears(_ fragments: [String], wait: TimeInterval) -> Bool {
		let deadline = Date().addingTimeInterval(wait)
		repeat {
			for fragment in fragments {
				let predicate = NSPredicate(format: "label CONTAINS[c] %@", fragment)
				if app.staticTexts.matching(predicate).firstMatch.exists { return true }
				if app.buttons.matching(predicate).firstMatch.exists { return true }
			}
			usleep(400_000)
		} while Date() < deadline
		return false
	}

	/// Saves the screen as `ipad-<orientation>-<shot>.png` only if one of `expect` is on it.
	@discardableResult
	private func capture(_ shot: String, expect: [String], wait: TimeInterval = 8) -> Bool {
		guard appears(expect, wait: wait) else {
			skipped.append("\(shot) (no \(expect.joined(separator: " / ")))")
			return false
		}
		dismissNotificationPrompt(wait: 1)
		sleep(1)
		let png = XCUIScreen.main.screenshot().pngRepresentation
		try? png.write(to: URL(fileURLWithPath: "\(dir)/ipad-\(orientation)-\(shot).png"))
		return true
	}

	private func open(_ title: String) -> Bool {
		let element = tab(title)
		guard element.waitForExistence(timeout: 8) else {
			skipped.append("\(title)-tab")
			return false
		}
		element.tap()
		sleep(2)
		return true
	}

	// MARK: Tour

	func testLayout() throws {
		launch()

		// The decision cards themselves, not the greeting: the feed loads after it.
		capture(
			"01-foryou",
			expect: ["Send 7 follow-ups to Northwind?", "Approve the Q4 webinar spend?"], wait: 40)

		if open("Chats") { capture("02-chats", expect: ["Chief of Staff", "Brand shoot"]) }

		if open("Flows") { capture("03-flows", expect: ["Outreach", "Renewals", "Webinars", "Pipeline"]) }

		if open("Items") {
			capture("04-items", expect: ["Contoso renewal terms", "Q4 webinar", "Northwind renewal risk"])
		}

		// Best effort, from a fresh launch: the + on For you lands on Chats with the new chat sheet
		// addressed to the Chief of Staff.
		launch()
		let plus = app.buttons["New chat with Chief of Staff"].firstMatch
		if plus.waitForExistence(timeout: 10) {
			plus.tap()
			sleep(3)
			capture("05-foryou-plus-chat-sheet", expect: ["Chief of Staff"])
		} else {
			skipped.append("foryou-plus (no New chat with Chief of Staff button)")
		}
	}
}
