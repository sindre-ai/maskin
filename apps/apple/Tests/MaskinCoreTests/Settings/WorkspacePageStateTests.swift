import Foundation
import Testing

@testable import MaskinCore

@Suite("WorkspacePageState")
struct WorkspacePageStateTests {
	@Test func triggerOnIsActiveAndPausedIsMuted() {
		#expect(WorkspacePageState.trigger(enabled: true) == PageState("On", .active))
		#expect(WorkspacePageState.trigger(enabled: false) == PageState("Paused", .muted))
	}

	@Test func onlySignInStatesAreAmber() {
		#expect(WorkspacePageState.integration(.connected).tone == .active)
		#expect(WorkspacePageState.integration(.needsReconnect(missingScopes: 2)).tone == .notice)
		#expect(WorkspacePageState.integration(.disconnected).tone == .notice)
		#expect(WorkspacePageState.integration(.incomplete).tone == .notice)
		#expect(WorkspacePageState.integrationAvailable.tone == .plain)
	}

	@Test func integrationSubtitleNamesAccountsNeverIds() {
		#expect(
			WorkspacePageState.integrationSubtitle(.connected, account: "me@x.com")
				== "Connected as me@x.com")
		#expect(WorkspacePageState.integrationSubtitle(.connected, account: nil) == "Connected")
		#expect(
			WorkspacePageState.integrationSubtitle(.needsReconnect(missingScopes: 1), account: "a")
				== "Needs sign-in")
	}

	@Test func memberSubtitles() {
		#expect(WorkspacePageState.memberSubtitle(isAgent: false, role: .owner, isYou: true) == "Owner · you")
		#expect(WorkspacePageState.memberSubtitle(isAgent: false, role: .member, isYou: false) == nil)
		#expect(WorkspacePageState.memberSubtitle(isAgent: true, role: .member, isYou: false) == "Agent")
	}

	@Test func triggerSubtitleIsPausedWhenOff() {
		let on = Trigger(id: "1", name: "n", kind: .cron, config: .object(["expression": .string("0 8 * * *")]))
		var off = on
		off.enabled = false
		#expect(WorkspacePageState.triggerSubtitle(on) == on.summary)
		#expect(WorkspacePageState.triggerSubtitle(off) == "Paused")
	}
}
