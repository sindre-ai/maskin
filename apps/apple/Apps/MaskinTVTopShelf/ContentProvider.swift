import MaskinCore
import TVServices

/// The Apple TV Top Shelf: the first decisions waiting on you, shown above the app icon. Reads the
/// same snapshot the iOS widgets do, with the session the TV app keeps in the shared Keychain
/// group, so it says "needs you" about exactly the cards For you puts first. Selecting an item
/// opens that decision in the app.
final class ContentProvider: TVTopShelfContentProvider {
	override func loadTopShelfContent() async -> (any TVTopShelfContent)? {
		let raw = Bundle.main.object(forInfoDictionaryKey: "MaskinAPIBaseURL") as? String
		let baseURL = raw.flatMap(URL.init(string:)) ?? URL(string: "https://maskin.io")!
		let state = await WidgetSnapshotLoader.live(baseURL: baseURL).load()
		// Signed out, nothing waiting, or offline: no content, and the shelf shows the app's own
		// static images.
		guard case .content(let snapshot) = state, !snapshot.decisions.isEmpty else { return nil }
		let items = snapshot.decisions.map { decision -> TVTopShelfSectionedItem in
			let item = TVTopShelfSectionedItem(identifier: decision.objectId)
			item.title = decision.title
			let url = snapshot.url(for: decision)
			item.displayAction = TVTopShelfAction(url: url)
			item.playAction = TVTopShelfAction(url: url)
			return item
		}
		let section = TVTopShelfItemCollection(items: items)
		section.title = snapshot.needsCount == 1 ? "1 needs you" : "\(snapshot.needsCount) need you"
		return TVTopShelfSectionedContent(sections: [section])
	}
}
