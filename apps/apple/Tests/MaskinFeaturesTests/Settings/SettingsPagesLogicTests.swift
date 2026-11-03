import Foundation
import MaskinCore
import Testing

@testable import MaskinFeatures

@Suite("Settings pages logic")
struct SettingsPagesLogicTests {
	@Test("a typed device code is upper-cased and given its dash")
	func codeNormalizes() {
		#expect(DeviceApprovalStore.normalize("bcdf2345") == "BCDF-2345")
		#expect(DeviceApprovalStore.normalize("BCDF-2345 extra") == "BCDF-2345")
		#expect(DeviceApprovalStore.normalize("bc") == "BC")
	}

	@Test("extensions list is alphabetical and carries no secret")
	func extensionsParse() {
		let json: [[String: Any]] = [
			["id": "2", "name": "Zeta", "status": "disabled", "hasSigningSecret": true, "toolGrants": ["a": 1]],
			["id": "1", "name": "alpha", "status": "active", "webhookUrl": "https://x/hook", "committedDeliveries": 4],
		]
		let list = ExtensionSummary.parseList(json)
		#expect(list.map(\.name) == ["alpha", "Zeta"])
		#expect(list[0].state.text == "On")
		#expect(list[1].state.text == "Off")
		#expect(list[1].toolGrantCount == 1)
	}

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

	@Test("pending invites parse newest first")
	func invitesParse() {
		let json: [[String: Any]] = [
			["id": "a", "email": "a@x.io", "role": "member", "invitedByName": "S", "createdAt": "2026-10-01T10:00:00Z"],
			["id": "b", "email": "b@x.io", "role": "admin", "invitedByName": "S", "createdAt": "2026-10-03T10:00:00Z"],
		]
		let list = PendingInvite.parseList(json)
		#expect(list.map(\.id) == ["b", "a"])
		#expect(list[0].role == .admin)
	}

	@Test("the Claude connection names the plan")
	func claudeParse() {
		let c = ClaudeConnection.parse(["connected": true, "valid": true, "subscription_type": "max", "slots": ["primary": [:]]])
		#expect(c?.planLabel == "Claude Max")
		#expect(c?.backups == 0)
	}
}

@Suite("GitHub installations")
struct GitHubInstallationTests {
	@Test("installations parse owner, scope drift and grants; other providers are ignored")
	func parse() {
		let json: [[String: Any]] = [
			["id": "i1", "provider": "github", "status": "active", "config": ["owner_login": "sindre-ai"],
			 "grantedScopes": ["repo"], "missingScopes": ["workflow"], "defaultAgentAccess": "read",
			 "agentGrants": [["actorId": "a1", "access": "read_write"]]],
			["id": "i2", "provider": "slack", "status": "active"],
		]
		let list = GitHubInstallation.parse(json)
		#expect(list.count == 1)
		#expect(list[0].owner == "sindre-ai")
		#expect(list[0].needsReconnect)
		#expect(list[0].access(for: "a1").level == .readWrite)
		#expect(list[0].access(for: "a2").isDefault)
		#expect(list[0].access(for: "a2").level == .read)
	}
}
