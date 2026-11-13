import Foundation
import Testing

@testable import MaskinCore

private struct FakePicturesAPI: ActorPicturesAPI {
	var result: Result<ActorLooks, any Error>

	func pictures() async throws -> ActorLooks { try result.get() }
}

private struct Offline: Error {}

@Suite("ActorPicturesStore")
@MainActor
struct ActorPicturesStoreTests {
	private let base = URL(string: "https://api.example.com")!

	@Test("resolves a picture path against the server address")
	func resolves() async {
		let store = ActorPicturesStore()
		await store.load(
			from: FakePicturesAPI(result: .success(ActorLooks(picturePaths: ["a1": "/api/actors/a1/avatar?v=3"]))), baseURL: base)
		#expect(store.url(for: "a1")?.absoluteString == "https://api.example.com/api/actors/a1/avatar?v=3")
	}

	@Test("an actor without a picture has no address")
	func missing() async {
		let store = ActorPicturesStore()
		await store.load(from: FakePicturesAPI(result: .success(ActorLooks(picturePaths: ["a1": "/api/actors/a1/avatar?v=3"]))), baseURL: base)
		#expect(store.url(for: "someone-else") == nil)
	}

	@Test("a failed reload keeps the pictures already loaded")
	func failedReload() async {
		let store = ActorPicturesStore()
		await store.load(from: FakePicturesAPI(result: .success(ActorLooks(picturePaths: ["a1": "/api/actors/a1/avatar?v=3"]))), baseURL: base)
		await store.load(from: FakePicturesAPI(result: .failure(Offline())), baseURL: base)
		#expect(store.url(for: "a1") != nil)
	}

	@Test("a reload replaces the pictures, so a removed one disappears")
	func reloadReplaces() async {
		let store = ActorPicturesStore()
		await store.load(from: FakePicturesAPI(result: .success(ActorLooks(picturePaths: ["a1": "/api/actors/a1/avatar?v=3"]))), baseURL: base)
		await store.load(from: FakePicturesAPI(result: .success(ActorLooks())), baseURL: base)
		#expect(store.url(for: "a1") == nil)
	}

	@Test("an actor's chosen letters are read back, and one that chose none has none")
	func chosenInitials() async {
		let store = ActorPicturesStore()
		await store.load(from: FakePicturesAPI(result: .success(ActorLooks(initials: ["a1": "DEV"]))), baseURL: base)
		#expect(store.initials(for: "a1") == "DEV")
		#expect(store.initials(for: "someone-else") == nil)
	}

	@Test("clearing the letters on the server clears them here on the next load")
	func clearedInitials() async {
		let store = ActorPicturesStore()
		await store.load(from: FakePicturesAPI(result: .success(ActorLooks(initials: ["a1": "DEV"]))), baseURL: base)
		await store.load(from: FakePicturesAPI(result: .success(ActorLooks())), baseURL: base)
		#expect(store.initials(for: "a1") == nil)
	}

	@Test("a failed reload keeps the letters already loaded")
	func failedReloadKeepsInitials() async {
		let store = ActorPicturesStore()
		await store.load(from: FakePicturesAPI(result: .success(ActorLooks(initials: ["a1": "DEV"]))), baseURL: base)
		await store.load(from: FakePicturesAPI(result: .failure(Offline())), baseURL: base)
		#expect(store.initials(for: "a1") == "DEV")
	}
}
