import XCTest

/// Walks the main iPhone screens in the demo workspace and writes a PNG of each to
/// `$SCREEN_TOUR_DIR` (default /tmp/screen-tour), so they can be compared with the design.
///
/// Best effort, and every section is independent: each one starts from a fresh launch, and a
/// screen that cannot be reached is skipped and logged (`skipped-*.txt`), never a failure and never
/// a reason to stop the run. A shot is only saved after a text that belongs to that screen is on
/// screen (`capture(_:expect:)`), so a mislabeled image cannot be written.
///
///   DEMO_PERF=1 PORT=3010 node scripts/demo-server/server.mjs
///   xcodebuild ... MASKIN_API_BASE_URL=http://localhost:3010 \
///     TEST_RUNNER_SCREEN_TOUR_DIR=/tmp/tour test -only-testing:MaskinUITests/ScreenTourTests
///
/// The runner only sees `TEST_RUNNER_`-prefixed variables, and strips the prefix: pass
/// `TEST_RUNNER_SCREEN_TOUR_DIR`, not `SCREEN_TOUR_DIR`. The default directory works without it.
@MainActor
final class ScreenTourTests: XCTestCase {
	private static let session =
		#"{"apiKey":"ank_demo","actorId":"00000000-0000-4000-8000-000000000002","name":"Sindre Aasen","email":"sindre@northwind.example","workspaceId":"00000000-0000-4000-8000-000000000001"}"#

	private var app = XCUIApplication()
	private let dir = ProcessInfo.processInfo.environment["SCREEN_TOUR_DIR"] ?? "/tmp/screen-tour"
	private var skipped: [String] = []

	override func setUp() async throws {
		continueAfterFailure = true
		try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
		launch()
	}

	override func tearDown() async throws {
		let tag =
			name.contains("Settings") ? "settings" : name.contains("Agents") ? "agents"
			: name.contains("ChatCards") ? "cards" : name.contains("Live") ? "live" : "tour"
		try? "skipped: \(skipped.joined(separator: ", "))\n"
			.write(toFile: "\(dir)/skipped-\(tag).txt", atomically: true, encoding: .utf8)
	}

	// MARK: Helpers

	private func launch() {
		app = XCUIApplication()
		app.launchEnvironment["MASKIN_DEMO_SESSION"] = Self.session
		app.launch()
		XCTAssertTrue(app.tabBars.buttons["For you"].waitForExistence(timeout: 30), "signed-in shell")
		sleep(3)
	}

	/// A section: starts from a fresh launch (so an earlier one cannot leave a sheet or a pushed
	/// screen in the way) and never throws out of the tour.
	private func section(_ label: String, _ body: () -> Void) {
		app.terminate()
		launch()
		let before = skipped.count
		body()
		if skipped.count > before { skipped.append("(in section \(label))") }
	}

	private func text(_ fragment: String) -> XCUIElement {
		app.staticTexts.matching(NSPredicate(format: "label CONTAINS[c] %@", fragment)).firstMatch
	}

	private func exactText(_ label: String) -> XCUIElement { app.staticTexts[label].firstMatch }

	/// True when any of the fragments shows up as text or a button label within `wait` seconds.
	private func appears(_ fragments: [String], wait: TimeInterval) -> Bool {
		let deadline = Date().addingTimeInterval(wait)
		repeat {
			for fragment in fragments {
				if text(fragment).exists { return true }
				if app.buttons.matching(NSPredicate(format: "label CONTAINS[c] %@", fragment)).firstMatch.exists {
					return true
				}
			}
			usleep(400_000)
		} while Date() < deadline
		return false
	}

	/// Saves the screen as `name.png` only if one of `expect` is on it; otherwise logs a skip.
	@discardableResult
	private func capture(_ shot: String, expect: [String], wait: TimeInterval = 8) -> Bool {
		guard appears(expect, wait: wait) else {
			skipped.append("\(shot) (no \(expect.joined(separator: " / ")))")
			return false
		}
		sleep(1)
		let png = XCUIScreen.main.screenshot().pngRepresentation
		try? png.write(to: URL(fileURLWithPath: "\(dir)/\(shot).png"))
		return true
	}

	@discardableResult
	private func tap(_ element: XCUIElement, _ label: String, wait: TimeInterval = 6) -> Bool {
		guard element.waitForExistence(timeout: wait) else {
			skipped.append(label)
			return false
		}
		if element.isHittable {
			element.tap()
		} else {
			element.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
		}
		sleep(2)
		return true
	}

	/// Scrolls up until the element is on screen (rows below the fold in Settings and the profile).
	private func reveal(_ element: XCUIElement) {
		var tries = 0
		while !element.isHittable, tries < 6 {
			app.swipeUp()
			tries += 1
		}
	}

	private func tapRow(_ title: String, label: String? = nil, wait: TimeInterval = 6) -> Bool {
		let row = exactText(title)
		guard row.waitForExistence(timeout: wait) else {
			skipped.append(label ?? "row-\(title)")
			return false
		}
		reveal(row)
		return tap(row, label ?? "row-\(title)", wait: 2)
	}

	/// Back from a pushed screen: the nav bar's back button, else the edge swipe.
	private func goBack() {
		let bar = app.navigationBars.buttons.element(boundBy: 0)
		if bar.exists, bar.isHittable {
			bar.tap()
		} else {
			let from = app.coordinate(withNormalizedOffset: CGVector(dx: 0.0, dy: 0.5))
			from.press(forDuration: 0.1, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.9, dy: 0.5)))
		}
		sleep(2)
	}

	/// Closes a sheet without ever terminating the app: a button if there is one, else a drag down.
	private func closeSheet() {
		for label in ["Done", "Close", "Cancel", "Dismiss"] {
			let button = app.buttons[label].firstMatch
			if button.exists, button.isHittable {
				button.tap()
				sleep(1)
				return
			}
		}
		let top = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.12))
		top.press(forDuration: 0.1, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.95)))
		sleep(1)
	}

	private func profileButton() -> XCUIElement {
		app.buttons.matching(
			NSPredicate(format: "label CONTAINS[c] 'profile' OR label CONTAINS[c] 'account' OR label == 'S'")
		).firstMatch
	}

	/// Opens the profile sheet from the For you top bar.
	private func openProfile() -> Bool {
		app.tabBars.buttons["For you"].tap()
		sleep(1)
		guard tap(profileButton(), "profile") else { return false }
		return appears(["Your profile"], wait: 6)
	}

	/// Profile sheet, then Settings.
	private func openSettings() -> Bool {
		guard openProfile() else { return false }
		return tapRow("Settings", label: "profile-settings")
	}

	// MARK: Tabs, items, search, sheets

	func testTour() throws {
		section("foryou") {
			capture("01-foryou", expect: ["Needs you", "Good", "decision"])
			app.swipeUp()
			sleep(1)
			capture("01b-foryou-scrolled", expect: ["Needs you", "Good", "decision", "waiting"])
		}

		section("chats") {
			guard tap(app.tabBars.buttons["Chats"], "chats-tab") else { return }
			capture("02-chats", expect: ["Chief of Staff", "Brand shoot"])
			let room = exactText("Brand shoot").exists ? exactText("Brand shoot") : exactText("Chief of Staff")
			if tap(room, "chat-thread") {
				sleep(6)
				capture("03-chat-thread", expect: ["Why not all 47 contacts?", "Seven follow-ups", "Message"])
			}
		}

		section("flows") {
			guard tap(app.tabBars.buttons["Flows"], "flows-tab") else { return }
			capture("04-flows", expect: ["Outreach", "Renewals", "Webinars", "Pipeline"])
			// A flow card by name; the loop screen is the one with the Setup / Briefings tabs.
			for flow in ["Webinars", "Renewals", "Pipeline", "Outreach"] where exactText(flow).exists {
				if tap(exactText(flow), "flow-detail") {
					if capture("05-flow-detail", expect: ["Setup", "Briefings", "Performance"]),
						tap(exactText("Activity"), "flow-activity", wait: 3)
					{
						capture("05b-flow-activity", expect: ["Activity"])
					}
				}
				break
			}
		}

		section("items") {
			guard tap(app.tabBars.buttons["Items"], "items-tab") else { return }
			capture("06-items", expect: ["Contoso renewal terms", "Q4 webinar", "Northwind renewal risk"])
			let first = ["Q4 webinar", "Contoso renewal terms", "Northwind renewal risk"].first { exactText($0).exists }
			if let first, tap(exactText(first), "item-detail") {
				capture("07-item-detail", expect: ["Activity", "Add property"])
			}
		}

		section("item-types") {
			guard tap(app.tabBars.buttons["Items"], "items-tab-b") else { return }
			for (shot, title) in [
				("14-item-bet", "Q4 webinar"), ("15-item-task", "Contoso renewal terms"),
				("16-item-insight", "Northwind renewal risk"),
			] where tap(exactText(title), shot) {
				capture(shot, expect: ["Activity", "Add property"])
				goBack()
			}
		}

		section("item-activity-and-property") {
			guard tap(app.tabBars.buttons["Items"], "items-tab-c") else { return }
			guard tap(exactText("Q4 webinar"), "item-for-activity") else { return }
			let add = app.buttons["Add property"].firstMatch
			reveal(add)
			if tap(add, "add-property") {
				capture("22-add-property", expect: ["Add property", "Name"])
				closeSheet()
			}
			if tap(exactText("Activity"), "item-activity-tab", wait: 4) {
				capture("21-item-activity", expect: ["commented", "Comment"])
			}
		}

		section("search") {
			guard tap(app.buttons["Search"].firstMatch, "search") else { return }
			capture("08-search", expect: ["Search", "Needs you", "Recent"])
			// Type a word so the Ask Chief of Staff and Create rows show.
			let field = app.searchFields.firstMatch.exists ? app.searchFields.firstMatch : app.textFields.firstMatch
			if field.exists {
				field.tap()
				field.typeText("Northwind")
				sleep(3)
				capture("08b-search-results", expect: ["Ask Chief of Staff"])
			} else {
				skipped.append("search-field")
			}
		}

		section("display-sheet") {
			if tap(app.buttons["Display"].firstMatch, "display-sheet") {
				capture("09-display-sheet", expect: ["Layout", "Sort", "Filter", "Display"])
				closeSheet()
			}
		}

		section("profile") {
			if openProfile() { capture("10-profile-sheet", expect: ["Your profile"]) }
		}
	}

	// MARK: Settings and the pages under it

	func testSettings() throws {
		section("settings-hub") {
			guard openSettings() else { return }
			capture("11-01-settings", expect: ["Notifications"])
			app.swipeUp()
			sleep(1)
			capture("11-01b-settings-lower", expect: ["Sign in a device", "App lock", "Billing"])
		}

		section("billing") {
			guard openSettings(), tapRow("Billing", label: "settings-billing") else { return }
			capture("11-04-billing", expect: ["Trial ends", "Credits this month", "Loading your plan"])
		}

		section("workspaces") {
			guard openSettings(), tapRow("Workspaces", label: "settings-workspaces") else { return }
			capture("11-07-workspaces", expect: ["Your workspaces"])
		}

		section("app-lock") {
			guard openSettings(), tapRow("App lock", label: "settings-app-lock") else { return }
			capture("11-08-app-lock", expect: ["Lock now", "Lock after"])
		}

		section("sign-in-device") {
			guard openSettings(), tapRow("Sign in a device", label: "settings-device") else { return }
			capture("11-09-sign-in-device", expect: ["8 character code", "Continue"])
		}

		section("item-types-page") {
			guard openSettings(), tapRow("Item types", label: "settings-item-types") else { return }
			capture("11-10-item-types", expect: ["Add type", "Bet", "Task", "Insight"])
		}

		section("members") {
			guard openProfile(), tapRow("Members", label: "profile-members") else { return }
			capture("11-02-members", expect: ["Hire an agent", "Priya Rao"])
			if tap(exactText("Priya Rao"), "member-detail") {
				capture("12b-member-detail", expect: ["Remove from workspace", "Can edit items"])
			}
		}

		section("integrations") {
			guard openProfile(), tapRow("Integrations", label: "profile-integrations") else { return }
			capture("11-03-integrations", expect: ["Import from Claude"])
			if tap(exactText("GitHub"), "github-integration", wait: 3) {
				capture("11-03b-github", expect: ["workflow", "Reconnect", "GitHub"])
			}
		}

		section("files") {
			guard openProfile() else { return }
			let opened =
				exactText("Files").exists
				? tapRow("Files", label: "profile-files")
				: (tapRow("Settings", label: "profile-settings") && tapRow("Files", label: "settings-files"))
			guard opened else { return }
			if capture("11-06-files", expect: [".html"]), tap(text(".html"), "file-detail") {
				capture("11-06b-file", expect: ["Replies up", "Signups", "Pipeline steady", "Three deals"])
			}
		}
	}

	// MARK: Agents and triggers

	func testAgentsAndTriggers() throws {
		section("agents") {
			guard openProfile(), tapRow("Agents", label: "profile-agents") else { return }
			capture("11-00-agents", expect: ["Outreach", "Chief of Staff"])
			guard tap(exactText("Outreach"), "agent-detail") else { return }
			sleep(3)
			guard capture("13-agent-detail", expect: ["Setup", "Triggers", "Sessions"]) else { return }
			let more = app.buttons.matching(
				NSPredicate(format: "label CONTAINS[c] 'more' OR label CONTAINS[c] 'actions' OR label CONTAINS[c] 'ellipsis'")
			).firstMatch
			if tap(more, "agent-menu", wait: 3) {
				capture("13b-agent-menu", expect: ["Disable agent", "Enable agent", "Delete agent"], wait: 4)
			}
		}

		section("triggers") {
			guard openProfile(), tapRow("Triggers", label: "profile-triggers") else { return }
			capture("17-triggers-list", expect: ["Review new tasks"])
			if tap(exactText("Review new tasks"), "trigger-event") {
				capture("18-trigger-event", expect: ["Reads as", "Delete trigger"])
				goBack()
			}
			if tap(exactText("Monday pipeline review"), "trigger-cron") {
				capture("19-trigger-cron", expect: ["Delete trigger", "Next run"])
				goBack()
			}
			if tap(app.buttons["New trigger"].firstMatch, "trigger-new", wait: 4) {
				capture("20-trigger-new", expect: ["Reads as", "Then", "When"])
			}
		}
	}

	// MARK: Chats: request cards, message menu, thread reply

	func testChatCards() throws {
		section("request-cards") {
			guard tap(app.tabBars.buttons["Chats"], "chats-tab") else { return }
			guard tap(exactText("Webinars"), "webinars-room") else { return }
			sleep(5)
			// The agent request cards in the Webinars room (keychain, tool server, integration access).
			if capture("34-request-cards", expect: ["Resend API key", "linear", "Gmail"], wait: 10) {
				app.swipeUp()
				sleep(1)
				capture("34b-request-cards-lower", expect: ["Gmail", "linear", "Resend"])
			}
		}
	}

	/// Live from For you, and Reply in thread from a message: does each action do anything?
	func testLiveAndThread() throws {
		section("thread-actions") {
			if app.buttons["Not now"].waitForExistence(timeout: 6) { app.buttons["Not now"].tap(); sleep(2) }
			guard tap(app.tabBars.buttons["Chats"], "chats") else { return }
			sleep(6)
			capture("30-chats-list", expect: ["Chief of Staff"])
			guard tap(exactText("Chief of Staff"), "thread", wait: 15) else { return }
			sleep(5)
			capture("31-thread-open", expect: ["Why not all 47 contacts?"])
			let msg = exactText("Why not all 47 contacts?")
			guard msg.waitForExistence(timeout: 8) else {
				skipped.append("no-message")
				return
			}
			msg.press(forDuration: 1.2)
			sleep(2)
			capture("32-message-menu", expect: ["Reply", "Copy"], wait: 4)
			let reply = app.buttons.matching(NSPredicate(format: "label CONTAINS[c] 'thread'")).firstMatch
			if tap(reply, "reply-in-thread", wait: 3) {
				sleep(3)
				capture("33-thread-reply", expect: ["Thread", "Reply"], wait: 4)
			}
		}
	}
}
