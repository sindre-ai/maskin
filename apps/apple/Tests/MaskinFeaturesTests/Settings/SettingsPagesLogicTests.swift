import Foundation
import MaskinCore
import Testing

@testable import MaskinFeatures

@Suite("Settings pages logic")
struct SettingsPagesLogicTests {
	@Test("a billing trial shows days left, a paid plan shows no banner")
	func trialBanner() {
		let trial = BillingUsage(
			plan: "trial", status: .active, usedCents: 0, capCents: nil, creditBalanceCents: 0,
			resetsInMs: 4 * 86_400_000 + 1000)
		#expect(BillingView.trialBanner(trial)?.title == "Trial ends in 5 days")
		var pro = trial
		pro.plan = "pro"
		#expect(BillingView.trialBanner(pro) == nil)
	}

	@Test("scopes parse the account name and what is still requested")
	func scopesParse() {
		let json: [[String: Any]] = [
			["id": "i1", "status": "active", "config": ["owner_login": "sindre-ai"],
			 "grantedScopes": ["repo"], "missingScopes": ["workflow"]],
			["id": "i2", "status": "active"],
		]
		let scopes = IntegrationScopes.parse(json, integrationID: "i1")
		#expect(scopes?.owner == "sindre-ai")
		#expect(scopes?.needsReconnect == true)
		#expect(scopes?.missing == ["workflow"])
		#expect(IntegrationScopes.parse(json, integrationID: "none") == nil)
	}

	@Test("a workspace row says role and people, and the current one has no action")
	func workspaceRows() {
		let list = [
			WorkspaceSummary(id: "b", name: "Beta", role: "member", memberCount: 1),
			WorkspaceSummary(id: "a", name: "Alpha", role: "owner", memberCount: 3),
		]
		let rows = WorkspacesPage.rows(list, selectedID: "a") { _ in }
		#expect(rows.map(\.title) == ["Alpha", "Beta"])
		#expect(rows[0].subtitle == "Owner \u{00B7} 3 people")
		#expect(rows[0].action == nil)
		#expect(rows[1].action != nil)
	}
}
