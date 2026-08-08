import XCTest

/// Smoke test — app launches to the auth screen when logged out. The full
/// login -> chats -> object -> comment flow (plan verification section) needs a seeded
/// backend and is run manually against `pnpm dev` rather than in this offline check.
final class MaskinUITests: XCTestCase {
	override func setUpWithError() throws {
		continueAfterFailure = false
	}

	func testLaunchesToAuthScreenWhenLoggedOut() throws {
		let app = XCUIApplication()
		app.launch()
		XCTAssertTrue(app.staticTexts["Maskin"].waitForExistence(timeout: 5))
	}
}
