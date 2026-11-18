import Foundation
import Testing

@testable import MaskinCore

private final class FakeFlagsAPI: FeatureFlagsAPI, @unchecked Sendable {
	var result: Result<[String: Bool], any Error> = .success([:])
	func flags() async throws -> [String: Bool] { try result.get() }
}

@Suite("FeatureFlagStore")
@MainActor
struct FeatureFlagStoreTests {
	@Test("everything is off until a load succeeds")
	func offByDefault() {
		let store = FeatureFlagStore(api: FakeFlagsAPI())
		#expect(!store.isEnabled(FeatureFlagID.createViewWithAgent))
	}

	@Test("a load turns the resolved flags on")
	func loads() async {
		let api = FakeFlagsAPI()
		api.result = .success([FeatureFlagID.createViewWithAgent: true, "other": false])
		let store = FeatureFlagStore(api: api)
		await store.load()
		#expect(store.isEnabled(FeatureFlagID.createViewWithAgent))
		#expect(!store.isEnabled("other"))
	}

	@Test("a failed load keeps what was known, and reset turns everything off")
	func failureAndReset() async {
		let api = FakeFlagsAPI()
		api.result = .success([FeatureFlagID.createViewWithAgent: true])
		let store = FeatureFlagStore(api: api)
		await store.load()
		api.result = .failure(FeatureFlagsError.unavailable)
		await store.load()
		#expect(store.isEnabled(FeatureFlagID.createViewWithAgent))
		store.reset()
		#expect(!store.isEnabled(FeatureFlagID.createViewWithAgent))
	}
}
