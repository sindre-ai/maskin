import Foundation
import Testing

@testable import MaskinCore

@MainActor
@Suite("SettingsCountsStore")
struct SettingsCountsStoreTests {
	private func store(
		_ fake: FakeSettings, triggers: @escaping @Sendable () async throws -> Int = { 3 },
		files: @escaping @Sendable (Int) async throws -> Int = { _ in 2 }
	) -> SettingsCountsStore {
		SettingsCountsStore(
			workspaceId: "ws", members: fake, integrations: fake, skills: fake, schema: fake, billing: fake,
			triggerCount: triggers, fileCount: files)
	}

	@Test("loads each figure")
	func loads() async {
		let fake = FakeSettings()
		fake.skillList = [WorkspaceSkill(id: "s1", name: "a", summary: nil, isValid: true)]
		let counts = store(fake)
		await counts.load()
		#expect(counts.skills == 1)
		#expect(counts.triggers == 3)
		#expect(counts.files == 2)
		#expect(counts.plan == "Pro")
		#expect(counts.itemTypes == 1)
	}

	@Test("a failing request leaves only its own figure empty")
	func failureIsolated() async {
		let counts = store(FakeSettings(), triggers: { throw SettingsError.mcpNotAvailable })
		await counts.load()
		#expect(counts.triggers == nil)
		#expect(counts.plan == "Pro")
	}

	@Test("a full page of files shows no number")
	func filesCapped() async {
		let counts = store(FakeSettings(), files: { $0 })
		await counts.load()
		#expect(counts.files == nil)
	}

	@Test("zero and unknown hide the detail")
	func detail() {
		#expect(SettingsCountsStore.detail(0) == nil)
		#expect(SettingsCountsStore.detail(nil) == nil)
		#expect(SettingsCountsStore.detail(4) == "4")
	}
}
