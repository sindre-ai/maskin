import XCTest

/// New message (v3 prototype): the sheet opens with Chief of Staff already chosen, the message
/// field has the keyboard, and the people list only exists while "Add someone" is focused.
@MainActor
final class NewMessageSheetTests: XCTestCase {
	private static let session =
		#"{"apiKey":"ank_demo","actorId":"00000000-0000-4000-8000-000000000002","name":"Sindre Aasen","email":"sindre@northwind.example","workspaceId":"00000000-0000-4000-8000-000000000001"}"#

	private var app = XCUIApplication()

	override func setUp() async throws {
		continueAfterFailure = false
		app = XCUIApplication()
		app.launchEnvironment["MASKIN_DEMO_SESSION"] = Self.session
		app.launch()
		XCTAssertTrue(app.tabBars.buttons["For you"].waitForExistence(timeout: 30), "signed-in shell")
		app.tabBars.buttons["Chats"].tap()
		sleep(3)
		let new = app.buttons["New conversation"].firstMatch
		XCTAssertTrue(new.waitForExistence(timeout: 10), "the + in the Chats bar")
		new.tap()
	}

	private func hasFocus(_ element: XCUIElement) -> Bool {
		(element.value(forKey: "hasKeyboardFocus") as? Bool) ?? false
	}

	func testOpensWithChiefOfStaffAndTheKeyboardOnTheMessage() {
		XCTAssertTrue(app.buttons["Remove Chief of Staff"].waitForExistence(timeout: 10), "Chief of Staff is already in To")
		let message = app.textViews.matching(NSPredicate(format: "placeholderValue CONTAINS %@", "Message")).firstMatch
		let field = message.exists ? message : app.textFields.matching(NSPredicate(format: "placeholderValue CONTAINS %@", "Message")).firstMatch
		XCTAssertTrue(field.waitForExistence(timeout: 10), "the message field")
		sleep(1)
		XCTAssertTrue(hasFocus(field), "the message field has the keyboard")
		XCTAssertFalse(app.staticTexts["SUGGESTED"].exists || app.staticTexts["Suggested"].exists, "no people list yet")
	}

	func testTheListAppearsWhenAddSomeoneIsFocusedAndAPickAddsAChip() {
		XCTAssertTrue(app.buttons["Remove Chief of Staff"].waitForExistence(timeout: 10))
		let to = app.textFields["To"]
		XCTAssertTrue(to.waitForExistence(timeout: 10), "the Add someone field")
		to.tap()
		let rows = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Add '"))
		XCTAssertTrue(rows.firstMatch.waitForExistence(timeout: 5), "the people list shows while To is focused")
		let first = rows.firstMatch.label
		rows.firstMatch.tap()
		let name = first.dropFirst(4).split(separator: ",").first.map(String.init) ?? ""
		XCTAssertTrue(app.buttons["Remove \(name)"].waitForExistence(timeout: 5), "picking adds a chip for \(name)")
		XCTAssertFalse(rows.firstMatch.exists && rows.firstMatch.isHittable, "the list closes after a pick")
		// The keyboard stays up and moves to the message.
		let field = app.textViews.matching(NSPredicate(format: "placeholderValue CONTAINS %@", "Message")).firstMatch
		let message = field.exists ? field : app.textFields.matching(NSPredicate(format: "placeholderValue CONTAINS %@", "Message")).firstMatch
		sleep(1)
		XCTAssertTrue(hasFocus(message), "after a pick the message field has the keyboard")
		// Removing the chip hands the keyboard back to To.
		app.buttons["Remove \(name)"].tap()
		sleep(1)
		XCTAssertTrue(hasFocus(app.textFields["To"]), "after removing a chip To has the keyboard")
	}
}
