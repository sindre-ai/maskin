import Testing

@testable import MaskinCore

@MainActor
@Suite("CardExpansion")
struct CardExpansionTests {
	@Test func cardsStartCompact() {
		#expect(CardExpansion().isExpanded("a") == false)
	}

	@Test func askExpandsOnlyThatCard() {
		let expansion = CardExpansion()
		expansion.expand("a")
		#expect(expansion.isExpanded("a"))
		#expect(expansion.isExpanded("b") == false)
	}

	@Test func showLessCollapsesAgain() {
		let expansion = CardExpansion()
		expansion.expand("a")
		expansion.collapse("a")
		#expect(expansion.isExpanded("a") == false)
	}

	@Test(arguments: [
		CardExpansion.Engagement(composerFocused: true),
		.init(hasDraft: true),
		.init(threadOpen: true),
	])
	func engagementOpensACompactCard(_ engagement: CardExpansion.Engagement) {
		let expansion = CardExpansion()
		#expect(expansion.isExpanded("a", engagement: engagement))
		#expect(expansion.isManuallyExpanded("a") == false)
	}

	@Test func engagedCardCannotBeCollapsed() {
		let expansion = CardExpansion()
		expansion.expand("a")
		let engaged = CardExpansion.Engagement(hasDraft: true)
		#expect(expansion.canCollapse("a", engagement: engaged) == false)
		expansion.collapse("a")
		#expect(expansion.isExpanded("a", engagement: engaged))
		#expect(expansion.isExpanded("a") == false)
	}

	@Test func pruneDropsCardsThatLeftTheFeed() {
		let expansion = CardExpansion()
		expansion.expand("a")
		expansion.expand("b")
		expansion.prune(keeping: ["b"])
		#expect(expansion.isManuallyExpanded("a") == false)
		#expect(expansion.isManuallyExpanded("b"))
	}
}

@Suite("ObjectLinks")
struct ObjectLinksTests {
	@Test func findsEveryOccurrenceIgnoringCase() {
		let text = "Ship the Launch plan. The launch plan needs you."
		let ranges = ObjectLinks.ranges(of: "launch plan", in: text)
		#expect(ranges.map { String(text[$0]) } == ["Launch plan", "launch plan"])
	}

	@Test func blankOrMissingNameFindsNothing() {
		#expect(ObjectLinks.ranges(of: nil, in: "text").isEmpty)
		#expect(ObjectLinks.ranges(of: "  ", in: "text").isEmpty)
		#expect(ObjectLinks.ranges(of: "absent", in: "text").isEmpty)
	}
}
