import XCTest

/// Scroll smoothness and memory, measured on the two screens that hold the most: a 400-message chat
/// thread full of photos, and the For you feed with its draft stack.
///
/// Needs the demo server in perf mode and an app built for it (see `scripts/perf-scroll.sh`, which
/// does both and prints the medians):
///
///   DEMO_PERF=1 PORT=3010 node scripts/demo-server/server.mjs
///   xcodebuild ... MASKIN_API_BASE_URL=http://localhost:3010 test -only-testing:MaskinUITests/ScrollPerfTests
///
/// Each test runs the same scroll `iterations` times and reports hitch time ratio, hitch count,
/// peak and average physical memory, and wall time for the scroll itself. Simulator numbers are
/// useful for comparing two builds on one machine, not as device numbers.
@MainActor
final class ScrollPerfTests: XCTestCase {
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

	private var options: XCTMeasureOptions {
		let o = XCTMeasureOptions()
		let env = ProcessInfo.processInfo.environment
		o.iterationCount = Int(env["PERF_ITERATIONS"] ?? "") ?? 5
		return o
	}

	private func metrics() -> [XCTMetric] {
		var all: [XCTMetric] = [XCTMemoryMetric(application: app), XCTClockMetric()]
		if #available(iOS 26.0, *) { all.insert(XCTHitchMetric(application: app), at: 0) }
		return all
	}

	/// Scrolls `swipes` times in `direction` with a fast flick, then puts the screen back.
	private func scrollRound(swipes: Int, away: () -> Void, back: () -> Void) {
		startMeasuring()
		for _ in 0..<swipes { away() }
		stopMeasuring()
		for _ in 0..<swipes { back() }
	}

	func testChatThreadScroll() throws {
		app.tabBars.buttons["Team"].tap()
		let row = app.staticTexts["Brand shoot"].firstMatch
		XCTAssertTrue(row.waitForExistence(timeout: 20), "long thread in the Team list")
		row.tap()
		// Let the newest page and its first photos arrive before measuring.
		sleep(6)
		measure(metrics: metrics(), options: options) {
			scrollRound(
				swipes: 12,
				away: { app.swipeDown(velocity: .fast) },
				back: { app.swipeUp(velocity: .fast) })
		}
	}

	func testForYouScroll() throws {
		app.tabBars.buttons["For you"].tap()
		// 40 cards and 12 drafts arrive in one response.
		XCTAssertTrue(
			app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS 'Contoso renewal terms'"))
				.firstMatch.waitForExistence(timeout: 30), "feed cards")
		sleep(3)
		measure(metrics: metrics(), options: options) {
			scrollRound(
				swipes: 12,
				away: { app.swipeUp(velocity: .fast) },
				back: { app.swipeDown(velocity: .fast) })
		}
	}
}
