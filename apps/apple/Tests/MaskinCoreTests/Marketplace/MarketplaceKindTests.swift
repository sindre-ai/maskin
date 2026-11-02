import Testing

@testable import MaskinCore

@Suite("Marketplace kinds")
struct MarketplaceKindTests {
	@Test func chipsAreAllAgentsFlowsIntegrationsInOrder() {
		#expect(MarketplaceKind.allCases.map(\.title) == ["All", "Agents", "Flows", "Integrations"])
	}

	@Test func onlyAllAndFlowsShowTheFlowsCatalog() {
		#expect(MarketplaceKind.all.showsFlows)
		#expect(MarketplaceKind.flows.showsFlows)
		#expect(!MarketplaceKind.agents.showsFlows)
		#expect(!MarketplaceKind.integrations.showsFlows)
	}

	@Test func kindsWithoutACatalogSayWhy() {
		#expect(MarketplaceKind.agents.emptyMessage != nil)
		#expect(MarketplaceKind.integrations.emptyMessage != nil)
		#expect(MarketplaceKind.flows.emptyMessage == nil)
	}
}
