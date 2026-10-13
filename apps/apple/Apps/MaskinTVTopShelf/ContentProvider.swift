import MaskinAPI
import MaskinCore
import TVServices

/// The Apple TV Top Shelf: the first two decisions waiting on you and today's briefing, shown
/// above the app icon. Decisions come from the same snapshot the iOS widgets read, with the session
/// the TV app keeps in the shared Keychain group, so the shelf says "needs you" about exactly the
/// cards For you puts first. Selecting a decision opens it in the app; the briefing opens For you,
/// where its card is the first in the carousel.
final class ContentProvider: TVTopShelfContentProvider {
	override func loadTopShelfContent() async -> (any TVTopShelfContent)? {
		let baseURL = Self.baseURL
		async let state = WidgetSnapshotLoader.live(baseURL: baseURL).load()
		async let brief = Self.todaysBriefing(baseURL: baseURL)
		let (loaded, briefing) = await (state, brief)

		var sections: [TVTopShelfItemCollection<TVTopShelfSectionedItem>] = []
		var workspaceId: String?
		if case .content(let snapshot) = loaded, !snapshot.decisions.isEmpty {
			workspaceId = snapshot.workspaceId
			let items = snapshot.decisions.prefix(2).map { decision -> TVTopShelfSectionedItem in
				let item = TVTopShelfSectionedItem(identifier: decision.objectId)
				item.title = decision.title
				let url = snapshot.url(for: decision)
				item.displayAction = TVTopShelfAction(url: url)
				item.playAction = TVTopShelfAction(url: url)
				return item
			}
			let section = TVTopShelfItemCollection(items: items)
			section.title = snapshot.needsCount == 1 ? "1 needs you" : "\(snapshot.needsCount) need you"
			sections.append(section)
		}
		if let briefing {
			let item = TVTopShelfSectionedItem(identifier: "daily-briefing")
			item.title = briefing.headline
			// For you is where the app opens; the link only has to be one the app accepts and ignores.
			let url = DeepLink.notifications(workspaceId: workspaceId ?? briefing.workspaceId).url
			item.displayAction = TVTopShelfAction(url: url)
			item.playAction = TVTopShelfAction(url: url)
			let section = TVTopShelfItemCollection(items: [item])
			section.title = "Today's briefing"
			sections.append(section)
		}
		// Signed out, nothing waiting and no briefing, or offline: no content, and the shelf shows
		// the app's own static images.
		guard !sections.isEmpty else { return nil }
		return TVTopShelfSectionedContent(sections: sections)
	}

	private static var baseURL: URL {
		let raw = Bundle.main.object(forInfoDictionaryKey: "MaskinAPIBaseURL") as? String
		return raw.flatMap(URL.init(string:)) ?? URL(string: "https://maskin.io")!
	}

	/// The daily briefing's headline, or nil when signed out, offline or slow: a shelf item that
	/// cannot be read is simply left out.
	private static func todaysBriefing(baseURL: URL) async -> (headline: String, workspaceId: String)? {
		guard let data = try? KeychainSecretStore().read(),
			let session = try? JSONDecoder().decode(StoredSession.self, from: data),
			let workspaceId = session.workspaceId, !workspaceId.isEmpty, !session.apiKey.isEmpty
		else { return nil }
		let credentials = MaskinCredentials(apiKey: session.apiKey, workspaceId: workspaceId)
		let client = MaskinClient.make(serverURL: baseURL, clientSource: "tvos", credentials: { credentials })
		let source = APISpokenBriefing(client: client, workspaceID: workspaceId)
		return await withTaskGroup(of: (headline: String, workspaceId: String)?.self) { group in
			group.addTask {
				guard let brief = try? await source.spokenBrief() else { return nil }
				let headline = brief.headline.trimmingCharacters(in: .whitespacesAndNewlines)
				return headline.isEmpty ? nil : (headline, workspaceId)
			}
			group.addTask {
				try? await Task.sleep(for: .seconds(6))
				return nil
			}
			let first = await group.next() ?? nil
			group.cancelAll()
			return first
		}
	}
}
