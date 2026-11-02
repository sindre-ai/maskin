import Foundation
import Testing

@testable import MaskinCore

@Suite("WatchSnapshot object link")
struct WatchSnapshotObjectTests {
	@Test("a card carries the object it is about through the phone context")
	func objectTitleSurvivesTheContext() throws {
		let snapshot = WatchSnapshot(
			cards: [WatchSnapshot.Card(id: "o1", sender: "Forge", headline: "Ship?", objectTitle: "Northwind renewal")],
			updatedAt: Date(timeIntervalSince1970: 100))
		let decoded = try #require(WatchSnapshot(context: snapshot.context()))
		#expect(decoded.cards.first?.objectTitle == "Northwind renewal")
	}

	@Test("a snapshot written before the field existed still decodes")
	func olderSnapshotsDecode() throws {
		let json = #"{"cards":[{"id":"o1","sender":"Forge","headline":"Ship?","summary":"","ask":"","options":[]}],"flows":[],"updatedAt":100}"#
		let decoder = JSONDecoder()
		decoder.dateDecodingStrategy = .secondsSince1970
		let decoded = try decoder.decode(WatchSnapshot.self, from: Data(json.utf8))
		#expect(decoded.cards.first?.objectTitle == nil)
	}

	@Test("the builder copies the feed card's object title")
	func builderCopiesTitle() {
		let card = ForYouCard(id: "o1", objectTitle: "Northwind renewal", latestActivityAt: nil)
		let entry = FeedEntry(card: card, bucket: .needs, record: nil)
		let snapshot = WatchSnapshotBuilder.make(
			entries: [entry], sender: { _ in "Forge" }, briefMarkdown: nil, loops: [], firstName: nil,
			now: Date(timeIntervalSince1970: 100))
		#expect(snapshot.cards.first?.objectTitle == "Northwind renewal")
	}
}
