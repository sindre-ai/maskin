import Foundation
import Testing

@testable import MaskinCore

@MainActor
@Suite("MembersStore add")
struct MembersAddTests {
	private let valid = "123e4567-e89b-12d3-a456-426614174000"

	private func make(_ fake: FakeSettings, role: MemberRole) -> MembersStore {
		fake.members = [member("me", "Me", role == .owner ? .owner : role)]
		return MembersStore(api: fake, workspaceId: "ws", currentRole: role, currentActorId: "me")
	}

	@Test("an admin adds a person by id, then the list reloads")
	func adds() async {
		let fake = FakeSettings()
		let store = make(fake, role: .admin)
		await store.load()
		#expect(await store.add(actorId: "  \(valid.uppercased())  ", role: .member))
		#expect(fake.calls.suffix(2) == ["add-member", "list-members"])
		#expect(fake.idempotencyKeys.count == 1)
		#expect(store.members.contains { $0.name == "New Person" })
	}

	@Test("a plain member cannot add, and junk ids never reach the server")
	func gated() async {
		let fake = FakeSettings()
		let member = make(fake, role: .member)
		#expect(!(await member.add(actorId: valid, role: .member)))
		let admin = make(fake, role: .admin)
		#expect(!(await admin.add(actorId: "not-a-uuid", role: .member)))
		#expect(!fake.calls.contains("add-member"))
	}

	@Test("owner can't be assigned and duplicates are refused locally")
	func ownerAndDuplicate() async {
		let fake = FakeSettings()
		let store = make(fake, role: .owner)
		await store.load()
		#expect(!(await store.add(actorId: valid, role: .owner)))
		fake.members.append(member(valid, "Dupe"))
		await store.load()
		#expect(!(await store.add(actorId: valid, role: .member)))
		#expect(store.actionError != nil)
		#expect(!fake.calls.contains("add-member"))
	}

	@Test("a server failure surfaces as a sentence")
	func failure() async {
		let fake = FakeSettings()
		let store = make(fake, role: .admin)
		fake.failure = SettingsError("No one has that id.")
		#expect(!(await store.add(actorId: valid, role: .member)))
		#expect(store.actionError == "No one has that id.")
	}
}

@MainActor
@Suite("SkillsStore editing")
struct SkillsEditingTests {
	@Test("name rules mirror the server")
	func names() {
		#expect(SkillsStore.isValidName("weekly-review-2"))
		#expect(!SkillsStore.isValidName("Weekly"))
		#expect(!SkillsStore.isValidName("has space"))
		#expect(!SkillsStore.isValidName(""))
		#expect(!SkillsStore.isValidName(String(repeating: "a", count: 65)))
		#expect(SkillsStore.suggestedName(from: "Weekly  Review!") == "weekly-review")
	}

	@Test("create, update and delete hit the API with idempotency keys and reload")
	func crud() async {
		let fake = FakeSettings()
		let store = SkillsStore(api: fake, workspaceId: "ws")
		#expect(await store.create(name: "triage", content: "Do the thing"))
		#expect(store.skills.map(\.name) == ["triage"])
		#expect(await store.update(name: "triage", content: "Do it better"))
		#expect(fake.skillBodies["triage"] == "Do it better")
		#expect(await store.delete(store.skills[0]))
		#expect(store.skills.isEmpty)
		#expect(fake.idempotencyKeys.count == 3)
	}

	@Test("invalid input is rejected before any request")
	func validation() async {
		let fake = FakeSettings()
		let store = SkillsStore(api: fake, workspaceId: "ws")
		#expect(!(await store.create(name: "Bad Name", content: "x")))
		#expect(!(await store.create(name: "ok", content: "   ")))
		#expect(fake.calls.isEmpty)
		#expect(store.actionError != nil)
	}

	@Test("a refused delete rolls the row back")
	func deleteRollsBack() async {
		let fake = FakeSettings()
		fake.skillList = [WorkspaceSkill(id: "1", name: "keep", summary: nil, isValid: true)]
		let store = SkillsStore(api: fake, workspaceId: "ws")
		await store.load()
		fake.failure = SettingsError("Nope.")
		#expect(!(await store.delete(store.skills[0])))
		#expect(store.skills.map(\.name) == ["keep"])
		#expect(store.actionError == "Nope.")
	}

	@Test("a duplicate name is caught locally")
	func duplicate() async {
		let fake = FakeSettings()
		fake.skillList = [WorkspaceSkill(id: "1", name: "dup", summary: nil, isValid: true)]
		let store = SkillsStore(api: fake, workspaceId: "ws")
		await store.load()
		#expect(!(await store.create(name: "dup", content: "x")))
		#expect(!fake.calls.contains("create-skill"))
	}
}

@MainActor
@Suite("BillingStore and BillingUsage")
struct BillingTests {
	@Test("loads usage")
	func loads() async {
		let store = BillingStore(api: FakeSettings())
		await store.load()
		#expect(store.phase == .loaded)
		#expect(store.usage?.planLabel == "Pro")
		#expect(store.usage?.usedFraction == 0.25)
	}

	@Test("a failure with nothing cached becomes the failed phase")
	func fails() async {
		let fake = FakeSettings()
		fake.failure = SettingsError("Offline.")
		let store = BillingStore(api: fake)
		await store.load()
		#expect(store.phase == .failed("Offline."))
	}

	@Test("formatting")
	func formatting() {
		#expect(BillingUsage.dollars(2_500, locale: Locale(identifier: "en_US")) == "$25")
		#expect(BillingUsage.dollars(2_550, locale: Locale(identifier: "en_US")) == "$25.50")
		var usage = FakeSettings().billingUsage
		usage.capCents = nil
		#expect(usage.usedFraction == nil)
		usage.usedCents = 99_999
		usage.capCents = 100
		#expect(usage.usedFraction == 1)
		usage.resetsInMs = 5 * 86_400_000
		#expect(usage.resetsText == "Resets in 5 days")
		usage.resetsInMs = 3 * 3_600_000
		#expect(usage.resetsText == "Resets in 3 hours")
		usage.resetsInMs = nil
		#expect(usage.resetsText == nil)
	}
}

@MainActor
@Suite("SchemaStore")
struct SchemaStoreTests {
	private func make(_ fake: FakeSettings, role: MemberRole = .admin) async -> SchemaStore {
		let store = SchemaStore(api: fake, currentRole: role)
		await store.load()
		return store
	}

	@Test("types list core types first")
	func types() async {
		let fake = FakeSettings()
		fake.schemaValue.statuses["zeta"] = ["a"]
		fake.schemaValue.statuses["task"] = ["todo"]
		let store = await make(fake)
		#expect(store.schema.types == ["bet", "task", "zeta"])
		#expect(store.schema.displayName(for: "zeta") == "Zeta")
	}

	@Test("adding a property sends only the field definitions key")
	func addProperty() async {
		let fake = FakeSettings()
		let store = await make(fake)
		let ok = await store.addProperty(
			PropertyDefinition(name: " budget ", kind: .number), to: "bet")
		#expect(ok)
		#expect(fake.savedKeys == [[.fieldDefinitions]])
		#expect(store.properties(of: "bet").map(\.name) == ["owner_team", "budget"])
	}

	@Test("choices are required for a choice property; names must be unique")
	func validation() async {
		let fake = FakeSettings()
		let store = await make(fake)
		#expect(!(await store.addProperty(PropertyDefinition(name: "pick", kind: .enum), to: "bet")))
		#expect(
			!(await store.addProperty(PropertyDefinition(name: "owner_team", kind: .text), to: "bet")))
		#expect(!(await store.addProperty(PropertyDefinition(name: " ", kind: .text), to: "bet")))
		#expect(fake.savedKeys.isEmpty)
		#expect(SchemaStore.parseValues("a, b ,a,, c") == ["a", "b", "c"])
	}

	@Test("a failed save rolls the schema back and shows the reason")
	func rollsBack() async {
		let fake = FakeSettings()
		let store = await make(fake)
		fake.failure = SettingsError("Only a workspace admin can change object types.")
		#expect(!(await store.removeProperty("owner_team", from: "bet")))
		#expect(store.properties(of: "bet").count == 1)
		#expect(store.actionError == "Only a workspace admin can change object types.")
	}

	@Test("members cannot edit")
	func gated() async {
		let fake = FakeSettings()
		let store = await make(fake, role: .member)
		#expect(!(await store.removeProperty("owner_team", from: "bet")))
		#expect(!(await store.addStatus("later", to: "bet")))
		#expect(fake.savedKeys.isEmpty)
	}

	@Test("statuses: add, reject duplicates, keep at least one, reorder")
	func statuses() async {
		let fake = FakeSettings()
		let store = await make(fake)
		#expect(await store.addStatus("paused", to: "bet"))
		#expect(!(await store.addStatus("PAUSED", to: "bet")))
		#expect(await store.moveStatuses(of: "bet", from: IndexSet(integer: 3), to: 0))
		#expect(store.statuses(of: "bet") == ["paused", "signal", "active", "done"])
		#expect(await store.removeStatus("done", from: "bet"))
		fake.schemaValue.statuses["task"] = ["only"]
		await store.load()
		#expect(!(await store.removeStatus("only", from: "task")))
		#expect(fake.savedKeys.allSatisfy { $0 == [.statuses] })
	}

	@Test("renaming a type sends only display names")
	func renames() async {
		let fake = FakeSettings()
		let store = await make(fake)
		#expect(await store.rename(type: "bet", to: "Initiative"))
		#expect(fake.savedKeys == [[.displayNames]])
		#expect(store.schema.displayName(for: "bet") == "Initiative")
	}

	@Test("wire decoding tolerates null settings and unknown kinds")
	func wire() {
		#expect(SettingsSchemaWire.decode(settingsJSON: Data("null".utf8)) == WorkspaceSchema())
		let json = """
			{"field_definitions":{"bet":[{"name":"a","type":"text"},{"name":"b","type":"weird"},
			{"name":"c","type":"enum","required":true,"values":["x","y"]}]},
			"statuses":{"bet":["s"]},"display_names":{"bet":"Bet"},"claude_oauth":{"secret":1}}
			"""
		let schema = SettingsSchemaWire.decode(settingsJSON: Data(json.utf8))
		#expect(schema.fieldDefinitions["bet"]?.map(\.name) == ["a", "c"])
		#expect(schema.fieldDefinitions["bet"]?.last?.values == ["x", "y"])
		#expect(schema.statuses["bet"] == ["s"])
	}

	@Test("the patch body carries only the changed keys")
	func patchBody() throws {
		let schema = FakeSettings().schemaValue
		let body = SettingsSchemaWire.patchBody(schema, keys: [.statuses])
		let data = try JSONEncoder().encode(body)
		let text = String(decoding: data, as: UTF8.self)
		#expect(text.contains("statuses"))
		#expect(!text.contains("field_definitions"))
		#expect(!text.contains("display_names"))
	}
}
