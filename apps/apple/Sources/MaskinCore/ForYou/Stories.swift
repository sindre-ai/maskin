import Foundation
import MaskinAPI

/// One card of the For you story row. A page is a briefing: an HTML file the Chief of Staff or a
/// loop marked `kind: briefing`. The `.briefing` content (the spoken script as text) is only built
/// by the TV app, which reads it aloud; the iPhone and iPad row is pages alone.
public struct StoryCard: Identifiable, Equatable, Sendable {
	public enum Content: Equatable, Sendable {
		case page(LoopOutput)
		case briefing(headline: String, script: String)
	}

	public var id: String
	/// The loop's name (or "Daily briefing"): the mono label at the top of the card.
	public var unit: String
	public var headline: String
	public var updatedAt: Date?
	public var content: Content
	/// The loop a page came from; nil for the daily briefing.
	public var loopID: String?

	public init(
		id: String, unit: String, headline: String, updatedAt: Date?, content: Content,
		loopID: String? = nil
	) {
		self.loopID = loopID
		self.id = id
		self.unit = unit
		self.headline = headline
		self.updatedAt = updatedAt
		self.content = content
	}
}

extension StoryCard {
	/// The unit of a briefing that no loop produced: the Chief of Staff's own.
	public static let chiefOfStaffUnit = "Chief of Staff"

	/// The Chief of Staff wrote it (rather than a loop), so its card wears the Chief of Staff's tile.
	public var isFromChiefOfStaff: Bool { loopID == nil }

	/// The mono line under the headline ("1 MIN READ"). A text briefing reads in `words / 200`
	/// minutes (at least one); a page is HTML, which has no length the app knows, so it is just
	/// labelled a briefing. A deck's "N CARDS \u{00B7} 0:30" needs a card count and
	/// duration the data does not carry.
	public var formatLabel: String {
		switch content {
		case .briefing(_, let script):
			let words = script.split(whereSeparator: \.isWhitespace).count
			return "\(max(1, Int((Double(words) / 200).rounded(.up)))) MIN READ"
		case .page:
			return "BRIEFING"
		}
	}

	/// Who the card is from, under the progress bar: the Chief of Staff for the daily briefing,
	/// else the flow the page came from.
	public var byline: String {
		switch content {
		case .briefing: "Chief of Staff"
		case .page: unit
		}
	}

	public var isBriefing: Bool {
		if case .briefing = content { return true }
		return false
	}
}

/// Today's brief as the Chief of Staff would say it (`POST /api/briefing/spoken`).
public struct SpokenBrief: Equatable, Sendable {
	public var headline: String
	public var script: String

	public init(headline: String, script: String) {
		self.headline = headline
		self.script = script
	}
}

public protocol SpokenBriefing: Sendable {
	func spokenBrief() async throws -> SpokenBrief
}

public struct APISpokenBriefing: SpokenBriefing {
	private let client: Client
	private let workspaceID: String

	public init(client: Client, workspaceID: String) {
		self.client = client
		self.workspaceID = workspaceID
	}

	public func spokenBrief() async throws -> SpokenBrief {
		let output = try await client.post_sol_api_sol_briefing_sol_spoken(
			.init(headers: .init(x_hyphen_workspace_hyphen_id: workspaceID)))
		guard case .ok(let ok) = output else { throw ForYouLoadError("Couldn't load the briefing.") }
		let body = try ok.body.json
		return SpokenBrief(headline: body.headline, script: body.script)
	}
}

/// Which pages are stories and what their cards say. Pure, so it is tested without a server.
public enum StoryDerivation {
	public static let maxPages = 12

	/// The page's own title: `<title>`, else the first `<h1>`, else its filename without the
	/// extension, with separators read as spaces.
	public static func headline(html: String?, fileName: String) -> String {
		if let html {
			for tag in ["title", "h1"] {
				if let text = firstText(of: tag, in: html), !text.isEmpty { return text }
			}
		}
		return fromFileName(fileName)
	}

	static func fromFileName(_ name: String) -> String {
		var base = name
		if let dot = base.lastIndex(of: "."), dot != base.startIndex { base = String(base[..<dot]) }
		let spaced = base.replacingOccurrences(of: "[_-]+", with: " ", options: .regularExpression)
			.trimmingCharacters(in: .whitespacesAndNewlines)
		return spaced.isEmpty ? name : spaced
	}

	private static func firstText(of tag: String, in html: String) -> String? {
		let pattern = "(?s)<\(tag)\\b[^>]*>(.*?)</\(tag)\\s*>"
		guard
			let range = html.range(of: pattern, options: [.regularExpression, .caseInsensitive])
		else { return nil }
		var inner = String(html[range])
		inner = inner.replacingOccurrences(of: "<[^>]*>", with: "", options: .regularExpression)
		inner = HTMLEntities.decode(inner)
		let collapsed = inner.split(whereSeparator: \.isWhitespace).joined(separator: " ")
		return collapsed.isEmpty ? nil : collapsed
	}

	/// The HTML briefings, newest first; a file with no date sorts last. The server already limits the
	/// list to `kind: briefing`, so this only drops what can't be shown as a page.
	public static func pages(from briefings: [FileSummary]) -> [FileSummary] {
		var seen = Set<String>()
		return briefings.filter { $0.kind == .html && seen.insert($0.id).inserted }
			.sorted { ($0.updatedAt ?? .distantPast) > ($1.updatedAt ?? .distantPast) }
			.prefix(maxPages).map { $0 }
	}

	public static func greeting(name: String?, now: Date = Date(), calendar: Calendar = .current) -> String {
		let hour = calendar.component(.hour, from: now)
		let part = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening"
		let first = name?.split(separator: " ").first.map(String.init)
		return first.map { "\(part), \($0)" } ?? part
	}
}

/// Which stories the reader has opened. A page that is edited afterwards is unseen again.
public struct SeenStories {
	private let defaults: UserDefaults
	private let key: String

	public init(defaults: UserDefaults = .standard, key: String = "forYou.seenStories") {
		self.defaults = defaults
		self.key = key
	}

	private func stamp(_ card: StoryCard) -> String {
		"\(card.id)@\(card.updatedAt.map { String(Int($0.timeIntervalSince1970)) } ?? "-")"
	}

	public func isSeen(_ card: StoryCard) -> Bool {
		(defaults.stringArray(forKey: key) ?? []).contains(stamp(card))
	}

	public func markSeen(_ card: StoryCard) {
		var all = defaults.stringArray(forKey: key) ?? []
		let value = stamp(card)
		guard !all.contains(value) else { return }
		all.append(value)
		defaults.set(Array(all.suffix(200)), forKey: key)
	}
}

/// The story row: every briefing (the Chief of Staff's, then loops'), newest first. A loop's other
/// output files are not stories.
@MainActor
@Observable
public final class StoriesStore {
	public private(set) var cards: [StoryCard] = []
	public private(set) var seenIDs: Set<String> = []
	/// True once `load()` has finished once, so a screen that shares the store loads it only if
	/// nobody has yet.
	public private(set) var hasLoaded = false
	/// The files already downloaded for the first few pages (their headlines needed them), so opening
	/// the viewer on one doesn't fetch it again. Only the first few: a deck can be half a megabyte.
	public private(set) var preloadedFiles: [String: FileDetail] = [:]
	public static let preloadCount = 3
	/// The last `load()` had a request fail (a flow, or a page file), so the row may be missing
	/// stories or show a file name where a headline belongs. `loadCompletely()` retries on this.
	public private(set) var isPartial = false

	@ObservationIgnored private let loops: any LoopsAPI
	@ObservationIgnored private let files: any FilesRemote
	@ObservationIgnored private let briefing: (any SpokenBriefing)?
	@ObservationIgnored private let seen: SeenStories
	@ObservationIgnored private let readerName: () -> String?
	@ObservationIgnored private let now: () -> Date
	@ObservationIgnored private let cache: SnapshotCache?

	public init(
		loops: any LoopsAPI, files: any FilesRemote, briefing: (any SpokenBriefing)?,
		seen: SeenStories = SeenStories(), readerName: @escaping () -> String? = { nil },
		now: @escaping () -> Date = Date.init, cache: SnapshotCache? = nil
	) {
		self.cache = cache
		self.loops = loops
		self.files = files
		self.briefing = briefing
		self.seen = seen
		self.readerName = readerName
		self.now = now
		seedFromCache()
	}

	/// The last row this device loaded, so For you paints at once and `load()` only refreshes it.
	/// `hasLoaded` stays false: a cached row is a starting point, not a finished load.
	private func seedFromCache() {
		guard let cached = cache?.read([CachedStory].self, Self.cacheName)?.value, !cached.isEmpty else { return }
		cards = cached.map(\.card)
		seenIDs = Set(cards.filter { seen.isSeen($0) }.map(\.id))
	}

	private static let cacheName = "for-you-stories"

	/// A page card as stored on disk (the card itself holds a `LoopOutput`, which is not `Codable`).
	private struct CachedStory: Codable {
		var id: String
		var unit: String
		var headline: String
		var updatedAt: Date?
		var loopID: String?
		var fileName: String
		var mimeType: String?

		init?(_ card: StoryCard) {
			guard case .page(let output) = card.content else { return nil }
			id = card.id
			unit = card.unit
			headline = card.headline
			updatedAt = card.updatedAt
			loopID = card.loopID
			fileName = output.name
			mimeType = output.mimeType
		}

		var card: StoryCard {
			StoryCard(
				id: id, unit: unit, headline: headline, updatedAt: updatedAt,
				content: .page(LoopOutput(id: id, name: fileName, mimeType: mimeType, updatedAt: updatedAt)),
				loopID: loopID)
		}
	}

	public func isSeen(_ card: StoryCard) -> Bool { seenIDs.contains(card.id) }

	/// The row's order: unseen cards first, seen ones after, each in their own order. Opening a card
	/// moves it to the end instead of leaving a white card at the front.
	public var rowCards: [StoryCard] {
		cards.filter { !seenIDs.contains($0.id) } + cards.filter { seenIDs.contains($0.id) }
	}

	public func preloadedFile(for id: String) -> FileDetail? { preloadedFiles[id] }

	/// The pages one loop produced, newest first (a loop's own page shows only its own cards).
	public func cards(forLoop loopID: String) -> [StoryCard] { cards.filter { $0.loopID == loopID } }

	public func markSeen(_ card: StoryCard) {
		seen.markSeen(card)
		seenIDs.insert(card.id)
	}

	/// Best effort throughout: a loop, page or briefing that fails to load is left out, and the
	/// row keeps whatever it already had.
	public func load() async {
		async let spoken = loadBriefing()
		async let pages = loadPages()
		let (brief, (found, details, failures)) = await (spoken, pages)
		var next: [StoryCard] = []
		if let brief {
			next.append(
				StoryCard(
					id: "briefing", unit: "Daily briefing",
					headline: StoryDerivation.greeting(name: readerName(), now: now()), updatedAt: nil,
					content: .briefing(headline: brief.headline, script: brief.script)))
		}
		next += found
		cards = next
		preloadedFiles = details
		isPartial = failures > 0
		hasLoaded = true
		seenIDs = Set(next.filter { seen.isSeen($0) }.map(\.id))
		// Keep the last good row: a load that came back empty (offline, a failed list) must not
		// wipe what the reader could already see.
		let toCache = next.compactMap(CachedStory.init)
		if !toCache.isEmpty { cache?.write(toCache, Self.cacheName) }
	}

	/// `load()` again, a couple of times with a growing pause, while it keeps coming back partial.
	/// The first load fires a request per flow and per page at once, alongside the feed; one that
	/// fails would otherwise leave the row short until the reader pulled down.
	public func loadCompletely(attempts: Int = 3, pause: Duration = .seconds(2)) async {
		for attempt in 1...max(attempts, 1) {
			await load()
			guard isPartial, attempt < attempts else { return }
			try? await Task.sleep(for: pause * attempt)
			if Task.isCancelled { return }
		}
	}

	private func loadBriefing() async -> SpokenBrief? {
		guard let briefing else { return nil }
		return try? await briefing.spokenBrief()
	}

	private func loadPages() async -> (cards: [StoryCard], details: [String: FileDetail], failures: Int) {
		guard let listed = try? await files.briefings(limit: StoryDerivation.maxPages * 2) else {
			return ([], [:], 1)
		}
		let chosen = StoryDerivation.pages(from: listed)
		// The loop lookup (one request per flow) and the page downloads share nothing, so they run
		// side by side: the row waits for the slower of the two, not the sum.
		async let attached = loopsAttached(to: Set(chosen.map(\.id)))
		let files = files
		let downloaded = await withTaskGroup(of: (Int, FileDetail?).self) { group in
			for (index, briefing) in chosen.enumerated() {
				group.addTask { (index, try? await files.file(id: briefing.id)) }
			}
			var result: [Int: FileDetail?] = [:]
			for await (index, detail) in group { result[index] = detail }
			return result
		}
		let (origin, lookupFailed) = await attached
		let fetched: [(Int, StoryCard, FileDetail?)] = chosen.enumerated().map { index, briefing in
			let detail = downloaded[index] ?? nil
			let loop = origin[briefing.id]
			let output = LoopOutput(
				id: briefing.id, name: briefing.name, mimeType: briefing.mimeType, updatedAt: briefing.updatedAt)
			return (
				index,
				StoryCard(
					id: briefing.id, unit: loop?.name ?? StoryCard.chiefOfStaffUnit,
					headline: StoryDerivation.headline(html: detail?.text, fileName: briefing.name),
					updatedAt: briefing.updatedAt, content: .page(output), loopID: loop?.id),
				detail)
		}
		var details: [String: FileDetail] = [:]
		for (card, detail) in fetched.map({ ($0.1, $0.2) }).prefix(Self.preloadCount) {
			if let detail { details[card.id] = detail }
		}
		let failures = (lookupFailed ? 1 : 0) + fetched.filter { $0.2 == nil }.count
		return (fetched.map(\.1), details, failures)
	}

	/// Which loop each of `ids` is attached to, so a loop's briefing is labelled with the loop and
	/// shows on its page. A briefing no loop holds belongs to the Chief of Staff. Best effort: when a
	/// lookup fails the briefings still show, and the result reports it so the row is retried.
	private func loopsAttached(
		to ids: Set<String>
	) async -> (origin: [String: (id: String, name: String)], failed: Bool) {
		guard !ids.isEmpty else { return ([:], false) }
		guard let all = try? await loops.loops() else { return ([:], true) }
		let loops = loops
		var failed = false
		var origin: [String: (id: String, name: String)] = [:]
		await withTaskGroup(of: (loop: (id: String, name: String), outputs: [LoopOutput])?.self) { group in
			for loop in all {
				group.addTask {
					guard let overview = try? await loops.overview(loopID: loop.id) else { return nil }
					return ((loop.id, loop.name ?? "Flow"), overview.outputs)
				}
			}
			for await part in group {
				guard let part else { failed = true; continue }
				for output in part.outputs where ids.contains(output.id) && origin[output.id] == nil {
					origin[output.id] = part.loop
				}
			}
		}
		return (origin, failed)
	}
}
