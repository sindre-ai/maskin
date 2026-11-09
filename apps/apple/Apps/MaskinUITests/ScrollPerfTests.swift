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
/// Each screen has two tests that run the same scroll `iterations` times: one reports peak and average
/// physical memory and wall time for the scroll itself, the other reports hitch time ratio and hitch
/// count. They are separate because the hitch metric crashes the test process on the simulator, and
/// that would take the memory and clock numbers with it. On the simulator the hitch tests skip with a
/// message; they run on a device. Simulator numbers are useful for comparing two builds on one
/// machine, not as device numbers.
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

	private func memoryAndClock() -> [XCTMetric] {
		[XCTMemoryMetric(application: app), XCTClockMetric()]
	}

	/// The hitch metric asserts inside MetricKit on the simulator, which ends the whole test process,
	/// so it is skipped there instead of run.
	private func hitch() throws -> [XCTMetric] {
		#if targetEnvironment(simulator)
			throw XCTSkip("XCTHitchMetric crashes on the simulator (MXMOSSignpostMetric harvestData); hitch needs a device.")
		#else
			guard #available(iOS 26.0, *) else { throw XCTSkip("XCTHitchMetric needs iOS 26.") }
			return [XCTHitchMetric(application: app)]
		#endif
	}

	/// Scrolls `swipes` times in `direction` with a fast flick, then puts the screen back.
	private func scrollRound(swipes: Int, away: () -> Void, back: () -> Void) {
		startMeasuring()
		for _ in 0..<swipes { away() }
		stopMeasuring()
		for _ in 0..<swipes { back() }
	}

	/// Waits for the thread row to exist and be tappable. A loaded runner can take well over 20 seconds
	/// to draw the Team list.
	private func openChatThread() {
		app.tabBars.buttons["Chats"].tap()
		let row = app.staticTexts["Brand shoot"].firstMatch
		XCTAssertTrue(row.waitForExistence(timeout: 90), "long thread in the Team list")
		let hittable = XCTNSPredicateExpectation(predicate: NSPredicate(format: "isHittable == true"), object: row)
		XCTAssertEqual(XCTWaiter().wait(for: [hittable], timeout: 90), .completed, "long thread row is tappable")
		row.tap()
		// Let the newest page and its first photos arrive before measuring.
		sleep(6)
	}

	private func openForYou() {
		app.tabBars.buttons["For you"].tap()
		// 40 cards and 12 drafts arrive in one response.
		XCTAssertTrue(
			app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS 'Contoso renewal terms'"))
				.firstMatch.waitForExistence(timeout: 30), "feed cards")
		sleep(3)
	}

	private func scrollChatThread(metrics: [XCTMetric]) {
		measure(metrics: metrics, options: options) {
			scrollRound(
				swipes: 12,
				away: { app.swipeDown(velocity: .fast) },
				back: { app.swipeUp(velocity: .fast) })
		}
	}

	private func scrollForYou(metrics: [XCTMetric]) {
		measure(metrics: metrics, options: options) {
			scrollRound(
				swipes: 12,
				away: { app.swipeUp(velocity: .fast) },
				back: { app.swipeDown(velocity: .fast) })
		}
	}

	func testChatThreadScroll() throws {
		openChatThread()
		scrollChatThread(metrics: memoryAndClock())
	}

	func testChatThreadHitch() throws {
		let metrics = try hitch()
		openChatThread()
		scrollChatThread(metrics: metrics)
	}

	func testForYouScroll() throws {
		openForYou()
		scrollForYou(metrics: memoryAndClock())
	}

	func testForYouHitch() throws {
		let metrics = try hitch()
		openForYou()
		scrollForYou(metrics: metrics)
	}
}
