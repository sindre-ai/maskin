import XCTest

/// Pulling a page down past its top opens that page's own search; the top-bar magnifier does the
/// same. Chats, Flows and Items. Strict: a page that does not open its field is a failure.
@MainActor
final class PullDownSearchTests: XCTestCase {
	private static let session =
		#"{"apiKey":"ank_demo","actorId":"00000000-0000-4000-8000-000000000002","name":"Sindre Aasen","email":"sindre@northwind.example","workspaceId":"00000000-0000-4000-8000-000000000001"}"#

	private var app = XCUIApplication()

	override func setUp() async throws {
		continueAfterFailure = false
		app = XCUIApplication()
		app.launchEnvironment["MASKIN_DEMO_SESSION"] = Self.session
		app.launch()
		XCTAssertTrue(app.tabBars.buttons["For you"].waitForExistence(timeout: 30), "signed-in shell")
	}

	/// Drags from just under the title down the screen, the way a thumb pulls a list.
	private func pullDown() {
		let start = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.28))
		let end = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.62))
		start.press(forDuration: 0.1, thenDragTo: end)
	}

	private func assertPullOpensSearch(tab: String, prompt: String, file: StaticString = #filePath, line: UInt = #line) {
		app.tabBars.buttons[tab].tap()
		sleep(3)
		let field = app.textFields[prompt]
		XCTAssertFalse(field.exists, "\(tab): search starts closed", file: file, line: line)
		pullDown()
		XCTAssertTrue(field.waitForExistence(timeout: 5), "\(tab): pulling down opens \(prompt)", file: file, line: line)
		app.buttons["Cancel"].tap()
		XCTAssertTrue(field.waitForNonExistence(timeout: 3), "\(tab): Cancel closes search", file: file, line: line)
	}

	func testChatsPullDownOpensSearch() { assertPullOpensSearch(tab: "Chats", prompt: "Search chats") }
	func testFlowsPullDownOpensSearch() { assertPullOpensSearch(tab: "Flows", prompt: "Search flows") }
	func testItemsPullDownOpensSearch() { assertPullOpensSearch(tab: "Items", prompt: "Search items") }

	func testTheTopBarMagnifierOpensTheSameField() {
		app.tabBars.buttons["Chats"].tap()
		sleep(3)
		app.buttons["Search"].firstMatch.tap()
		XCTAssertTrue(app.textFields["Search chats"].waitForExistence(timeout: 5))
	}
}
