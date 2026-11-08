import XCTest

/// The profile sheet is the only way into the Settings page (Files, the analytics switch). It has
/// to stay reachable: the sheet shows a Settings row, and tapping it opens the page.
@MainActor
final class ProfileSheetSettingsTests: XCTestCase {
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

	private func openProfile() {
		app.tabBars.buttons["For you"].tap()
		let avatar = app.buttons["Account"].firstMatch
		XCTAssertTrue(avatar.waitForExistence(timeout: 10), "the account button on For you")
		avatar.tap()
		XCTAssertTrue(app.staticTexts["Profile"].waitForExistence(timeout: 10), "the profile sheet opens")
	}

	func testSettingsRowOpensTheSettingsPageWithFiles() {
		openProfile()
		let row = app.buttons["Settings"].firstMatch
		for _ in 0..<4 where !row.exists || !row.isHittable { app.swipeUp() }
		XCTAssertTrue(row.waitForExistence(timeout: 5), "a Settings row in the profile sheet")
		row.tap()
		// The page lists Files under Workspace; the row's label may carry its count.
		let files = app.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH 'Files'")).firstMatch
		for _ in 0..<4 where !files.exists { app.swipeUp() }
		let shot = XCUIScreen.main.screenshot().pngRepresentation
		try? shot.write(to: URL(fileURLWithPath: "/tmp/settings-page.png"))
		XCTAssertTrue(files.waitForExistence(timeout: 8), "Settings opens and lists Files")
	}
}
