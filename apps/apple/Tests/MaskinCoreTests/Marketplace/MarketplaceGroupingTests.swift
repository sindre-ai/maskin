import Foundation
import Testing

@testable import MaskinCore

@MainActor
@Suite("MarketplaceStore grouping")
struct MarketplaceGroupingTests {
	private let loops = [
		MarketplaceLoop(id: "a", name: "SEO Content", useCase: "Content"),
		MarketplaceLoop(id: "b", name: "LinkedIn content", useCase: "Content"),
		MarketplaceLoop(id: "c", name: "Investor pipeline", useCase: "Founders"),
		MarketplaceLoop(id: "d", name: "Product Delivery", useCase: "Engineering"),
		MarketplaceLoop(id: "e", name: "Loose flow"),
	]

	private func store(installed: [InstalledLoop] = []) async -> MarketplaceStore {
		let store = MarketplaceStore(api: FakeMarketplaceAPI(loops: loops, installed: installed))
		await store.load()
		return store
	}

	@Test("the catalog groups by use case A to Z with Other last")
	func groups() async {
		let groups = await store().catalogGroups(query: "")
		#expect(groups.map(\.title) == ["Content", "Engineering", "Founders", "Other"])
		#expect(groups[0].loops.map(\.name) == ["LinkedIn content", "SEO Content"])
	}

	@Test("an installed flow leaves the catalog and shows under Installed")
	func installedLeavesCatalog() async {
		let store = await store(installed: [InstalledLoop(id: "i", sourceLoopID: "d")])
		#expect(!store.catalogGroups(query: "").flatMap(\.loops).contains { $0.id == "d" })
		#expect(store.installedEntries(query: "").map(\.loop?.name) == ["Product Delivery"])
	}

	@Test("search narrows both lists")
	func search() async {
		let store = await store(installed: [InstalledLoop(id: "i", sourceLoopID: "d")])
		#expect(store.installedEntries(query: "seo").isEmpty)
		#expect(store.catalogGroups(query: "seo").flatMap(\.loops).map(\.id) == ["a"])
	}
}
