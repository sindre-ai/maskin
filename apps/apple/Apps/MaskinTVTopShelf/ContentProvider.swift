import MaskinAPI
import MaskinCore
import TVServices
import UIKit

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
				Self.setImage(on: item, id: decision.objectId, headline: decision.title, eyebrow: "NEEDS YOU")
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
			Self.setImage(on: item, id: "daily-briefing", headline: briefing.headline, eyebrow: "TODAY'S BRIEFING")
			// The app opens For you and plays the briefing for the workspace's home link.
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

	// MARK: Tile images

	/// A sectioned item with no image renders as a blank tile, and the shelf cannot fetch anything
	/// from the app bundle, so each tile gets a card drawn here and written to the extension's caches.
	private static func setImage(on item: TVTopShelfSectionedItem, id: String, headline: String, eyebrow: String) {
		item.imageShape = .hdtv
		let safeID = id.filter { $0.isLetter || $0.isNumber || $0 == "-" }
		let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
		for (scale, trait) in [(1.0, TVTopShelfItem.ImageTraits.screenScale1x), (2.0, .screenScale2x)] {
			let url = caches.appendingPathComponent("shelf-\(safeID)-\(Int(scale))x.png")
			guard let data = card(headline: headline, eyebrow: eyebrow, scale: scale).pngData() else { continue }
			try? data.write(to: url, options: .atomic)
			item.setImageURL(url, for: trait)
		}
	}

	private static func card(headline: String, eyebrow: String, scale: CGFloat) -> UIImage {
		let size = CGSize(width: 640, height: 360)
		let format = UIGraphicsImageRendererFormat()
		format.scale = scale
		return UIGraphicsImageRenderer(size: size, format: format).image { context in
			let bounds = CGRect(origin: .zero, size: size)
			UIColor(red: 0.11, green: 0.11, blue: 0.12, alpha: 1).setFill()
			context.fill(bounds)
			let inset = bounds.insetBy(dx: 36, dy: 36)
			let eyebrowAttributes: [NSAttributedString.Key: Any] = [
				.font: UIFont.monospacedSystemFont(ofSize: 24, weight: .semibold),
				.foregroundColor: UIColor(white: 0.62, alpha: 1),
			]
			eyebrow.draw(in: CGRect(x: inset.minX, y: inset.minY, width: inset.width, height: 32), withAttributes: eyebrowAttributes)
			let paragraph = NSMutableParagraphStyle()
			paragraph.lineBreakMode = .byTruncatingTail
			let headlineAttributes: [NSAttributedString.Key: Any] = [
				.font: UIFont.systemFont(ofSize: 40, weight: .bold),
				.foregroundColor: UIColor.white,
				.paragraphStyle: paragraph,
			]
			headline.draw(
				with: CGRect(x: inset.minX, y: inset.minY + 52, width: inset.width, height: inset.height - 52),
				options: [.usesLineFragmentOrigin, .truncatesLastVisibleLine], attributes: headlineAttributes, context: nil)
		}
	}
}
