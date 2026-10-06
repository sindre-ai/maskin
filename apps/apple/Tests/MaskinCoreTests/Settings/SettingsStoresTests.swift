import Foundation
import Testing

@testable import MaskinCore

@MainActor
@Suite("MembersStore")
struct MembersStoreTests {
	private func make(_ fake: FakeSettings, role: MemberRole, me: String = "me") -> MembersStore {
		fake.members = [
			member("o", "Olive Owner", .owner), member("me", "Me Myself", role == .owner ? .owner : role),
			member("a", "Ari Admin", .admin), member("m", "Mo Member"),
			member("ag", "Relay", .member, agent: true),
		]
		return MembersStore(api: fake, workspaceId: "ws", currentRole: role, currentActorId: me)
	}

	@Test("loads, orders owners then admins then members, splits agents")
	func loads() async {
		let store = make(FakeSettings(), role: .admin)
		await store.load()
		#expect(store.phase == .loaded)
		#expect(store.humans.map(\.id) == ["o", "a", "me", "m"])
		#expect(store.agents.map(\.id) == ["ag"])
	}

	@Test("a plain member sees no destructive or role actions")
	func memberGated() async {
		let store = make(FakeSettings(), role: .member)
		await store.load()
		for m in store.members {
			#expect(!store.canChangeRole(of: m))
			#expect(!store.canRemove(m))
		}
	}

	@Test("an admin cannot touch the owner, themselves or change an agent's role")
	func adminBounds() async {
		let store = make(FakeSettings(), role: .admin)
		await store.load()
		let byId = Dictionary(uniqueKeysWithValues: store.members.map { ($0.id, $0) })
		#expect(!store.canChangeRole(of: byId["o"]!))
		#expect(!store.canRemove(byId["o"]!))
		#expect(!store.canRemove(byId["me"]!))
		#expect(!store.canChangeRole(of: byId["ag"]!))
		#expect(store.canRemove(byId["ag"]!))
		#expect(store.canChangeRole(of: byId["m"]!))
		#expect(store.canRemove(byId["m"]!))
	}

	@Test("a gated action makes no request")
	func gatedNoRequest() async {
		let fake = FakeSettings()
		let store = make(fake, role: .member)
		await store.load()
		let target = store.members.first { $0.id == "m" }!
		#expect(await store.remove(target) == false)
		#expect(await store.setRole(.admin, for: target) == false)
		#expect(!fake.calls.contains("remove-member"))
		#expect(!fake.calls.contains("set-role"))
	}

	@Test("role change is optimistic and sends an idempotency key")
	func roleChange() async {
		let fake = FakeSettings()
		let store = make(fake, role: .owner)
		await store.load()
		let target = store.members.first { $0.id == "m" }!
		#expect(await store.setRole(.admin, for: target))
		#expect(store.members.first { $0.id == "m" }?.role == .admin)
		#expect(fake.idempotencyKeys.count == 1)
	}

	@Test("a refused role change rolls back and explains")
	func roleRollback() async {
		let fake = FakeSettings()
		let store = make(fake, role: .owner)
		await store.load()
		fake.failure = SettingsError("Only a workspace admin can change roles.")
		let target = store.members.first { $0.id == "m" }!
		#expect(await store.setRole(.admin, for: target) == false)
		#expect(store.members.first { $0.id == "m" }?.role == .member)
		#expect(store.actionError == "Only a workspace admin can change roles.")
		#expect(store.busyIDs.isEmpty)
	}

	@Test("owner is never assignable as a role")
	func noOwnerAssignment() async {
		let fake = FakeSettings()
		let store = make(fake, role: .owner)
		await store.load()
		let target = store.members.first { $0.id == "m" }!
		#expect(await store.setRole(.owner, for: target) == false)
		#expect(!fake.calls.contains("set-role"))
	}

	@Test("remove drops the row; a refusal restores it")
	func removeAndRollback() async {
		let fake = FakeSettings()
		let store = make(fake, role: .admin)
		await store.load()
		let target = store.members.first { $0.id == "m" }!
		#expect(await store.remove(target))
		#expect(!store.members.contains { $0.id == "m" })
		fake.failure = SettingsError("This member owns billing. Move billing to someone else first.")
		let other = store.members.first { $0.id == "a" }!
		#expect(await store.remove(other) == false)
		#expect(store.members.contains { $0.id == "a" })
		#expect(store.actionError?.contains("billing") == true)
	}

	@Test("a failed first load is a failed phase; a failed reload keeps the list")
	func loadFailure() async {
		let fake = FakeSettings()
		fake.failure = SettingsError("down")
		let store = make(fake, role: .admin)
		await store.load()
		#expect(store.phase == .failed("down"))
		fake.failure = nil
		await store.load()
		fake.failure = SettingsError("down again")
		await store.load()
		#expect(store.phase == .loaded)
		#expect(!store.members.isEmpty)
		#expect(store.actionError == "down again")
	}
}

@MainActor
@Suite("IntegrationsStore")
struct IntegrationsStoreTests {
	private func make(_ fake: FakeSettings, role: MemberRole = .admin) -> IntegrationsStore {
		fake.providerList = [
			IntegrationProvider(id: "slack", displayName: "Slack", authKind: .oauth),
			IntegrationProvider(id: "gmail", displayName: "Gmail", authKind: .oauth, showsEmail: true),
			IntegrationProvider(id: "linear", displayName: "Linear", authKind: .oauth),
		]
		fake.connectedList = [
			ConnectedIntegration(id: "i1", provider: "slack", state: .connected, externalId: "T09ABCDEF"),
			ConnectedIntegration(id: "i2", provider: "gmail", state: .connected, externalId: "a@b.co"),
			ConnectedIntegration(id: "i3", provider: "retired-thing", state: .disconnected),
		]
		return IntegrationsStore(api: fake, currentRole: role)
	}

	@Test("provider ids never become labels")
	func namesResolved() async {
		let store = make(FakeSettings())
		await store.load()
		let byProvider = Dictionary(uniqueKeysWithValues: store.connected.map { ($0.provider, $0) })
		#expect(store.displayName(for: byProvider["slack"]!) == "Slack")
		#expect(store.displayName(for: byProvider["retired-thing"]!) == "Integration")
		// An opaque team id is never an account label; an email is.
		#expect(store.accountLabel(for: byProvider["slack"]!) == nil)
		#expect(store.accountLabel(for: byProvider["gmail"]!) == "a@b.co")
	}

	@Test("available lists only providers without a connection")
	func available() async {
		let store = make(FakeSettings())
		await store.load()
		#expect(store.available.map(\.id) == ["linear"])
	}

	@Test("state is derived from status, scope drift and incomplete setup")
	func stateMapping() {
		func state(_ status: String, drift: Bool = false) -> ConnectedIntegration.State {
			ConnectedIntegration(
				id: "x", provider: "p", status: status, externalId: nil, missingScopes: drift ? 2 : 0,
				needsReconnect: drift
			).state
		}
		#expect(state("active") == .connected)
		#expect(state("active", drift: true) == .needsReconnect(missingScopes: 2))
		#expect(state("pending") == .incomplete)
		#expect(state("awaiting_secret") == .incomplete)
		#expect(state("revoked") == .disconnected)
		#expect(state("error") == .disconnected)
		#expect(state("inactive") == .disconnected)
	}

	@Test("disconnect is optimistic and rolls back on failure")
	func disconnect() async {
		let fake = FakeSettings()
		let store = make(fake)
		await store.load()
		let first = store.connected.first { $0.id == "i1" }!
		#expect(await store.disconnect(first))
		#expect(!store.connected.contains { $0.id == "i1" })
		fake.failure = SettingsError("nope")
		let second = store.connected.first { $0.id == "i2" }!
		#expect(await store.disconnect(second) == false)
		#expect(store.connected.contains { $0.id == "i2" })
		#expect(store.actionError == "nope")
	}

	@Test("a plain member cannot disconnect")
	func memberGated() async {
		let fake = FakeSettings()
		let store = make(fake, role: .member)
		await store.load()
		#expect(!store.canManage)
		#expect(await store.disconnect(store.connected[0]) == false)
		#expect(!fake.calls.contains("disconnect"))
	}
}

@MainActor
@Suite("ProfileStore")
struct ProfileStoreTests {
	private func make(_ fake: FakeSettings) -> ProfileStore {
		ProfileStore(api: fake, profile: ProfileInfo(actorId: "me", name: "Alex", email: "a@b.co"))
	}

	@Test("saves a trimmed name")
	func saves() async {
		let fake = FakeSettings()
		let store = make(fake)
		#expect(await store.saveName("  Alexandra  "))
		#expect(store.profile.name == "Alexandra")
		#expect(fake.idempotencyKeys.count == 1)
	}

	@Test("a saved name is pushed into the session; a failed save is not")
	func updatesSession() async {
		let fake = FakeSettings()
		var names: [String] = []
		let store = ProfileStore(
			api: fake, profile: ProfileInfo(actorId: "me", name: "Alex", email: "a@b.co"),
			updateSessionName: { names.append($0) })
		#expect(await store.saveName("Alexandra"))
		#expect(names == ["Alexandra"])
		fake.failure = SettingsError("nope")
		#expect(await store.saveName("Other") == false)
		#expect(names == ["Alexandra"])
	}

	@Test("empty or unchanged names are not savable")
	func validation() async {
		let store = make(FakeSettings())
		#expect(!store.canSave(name: "   "))
		#expect(!store.canSave(name: "Alex"))
		#expect(store.canSave(name: "Alexa"))
		#expect(await store.saveName("") == false)
	}

	@Test("a refused save restores the old name")
	func rollback() async {
		let fake = FakeSettings()
		fake.failure = SettingsError("Couldn't save your name.")
		let store = make(fake)
		#expect(await store.saveName("Zed") == false)
		#expect(store.profile.name == "Alex")
		#expect(store.error == "Couldn't save your name.")
	}
}

@MainActor
@Suite("WorkspaceSettingsStore")
struct WorkspaceSettingsStoreTests {
	@Test("create refreshes the list before selecting the new workspace")
	func createOrder() async {
		let fake = FakeSettings()
		var events: [String] = []
		let store = WorkspaceSettingsStore(
			api: fake, refreshWorkspaces: { events.append("refresh") },
			selectWorkspace: { events.append("select:\($0)") })
		#expect(await store.create(name: "  New  "))
		#expect(events == ["refresh", "select:ws-new"])
	}

	@Test("a failed create selects nothing")
	func createFailure() async {
		let fake = FakeSettings()
		fake.failure = SettingsError("Your plan doesn't allow another workspace.")
		var selected = false
		let store = WorkspaceSettingsStore(
			api: fake, refreshWorkspaces: {}, selectWorkspace: { _ in selected = true })
		#expect(await store.create(name: "X") == false)
		#expect(!selected)
		#expect(store.error?.contains("plan") == true)
	}

	@Test("only managers can rename, and only to a different non-empty name")
	func renameGating() {
		let store = WorkspaceSettingsStore(
			api: FakeSettings(), refreshWorkspaces: {}, selectWorkspace: { _ in })
		#expect(store.canRename(to: "B", current: "A", role: .admin))
		#expect(!store.canRename(to: "B", current: "A", role: .member))
		#expect(!store.canRename(to: " ", current: "A", role: .owner))
		#expect(!store.canRename(to: "A", current: "A", role: .owner))
	}

	@Test("rename refreshes the list")
	func rename() async {
		var refreshed = 0
		let store = WorkspaceSettingsStore(
			api: FakeSettings(), refreshWorkspaces: { refreshed += 1 }, selectWorkspace: { _ in })
		#expect(await store.rename(workspaceId: "ws", to: "Renamed"))
		#expect(refreshed == 1)
	}
}

@MainActor
@Suite("SkillsStore")
struct SkillsStoreTests {
	@Test("lists skills alphabetically")
	func lists() async {
		let fake = FakeSettings()
		fake.skillList = [
			WorkspaceSkill(id: "2", name: "write-copy", summary: nil, isValid: true),
			WorkspaceSkill(id: "1", name: "Audit", summary: "Checks", isValid: false),
		]
		let store = SkillsStore(api: fake, workspaceId: "ws")
		await store.load()
		#expect(store.skills.map(\.name) == ["Audit", "write-copy"])
		#expect(store.phase == .loaded)
	}

	@Test("a failed first load surfaces the failure")
	func failure() async {
		let fake = FakeSettings()
		fake.failure = SettingsError("down")
		let store = SkillsStore(api: fake, workspaceId: "ws")
		await store.load()
		#expect(store.phase == .failed("down"))
	}
}
