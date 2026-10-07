import Foundation
import MaskinAPI

/// One card of the For you story row. A page is a loop's HTML outcome; the briefing is the
/// Chief of Staff's spoken brief for today, shown as text.
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
		for (entity, char) in [("&amp;", "&"), ("&lt;", "<"), ("&gt;", ">"), ("&quot;", "\""), ("&#39;", "'"), ("&nbsp;", " ")] {
			inner = inner.replacingOccurrences(of: entity, with: char)
		}
		let collapsed = inner.split(whereSeparator: \.isWhitespace).joined(separator: " ")
		return collapsed.isEmpty ? nil : collapsed
	}

	/// Newest first; a file with no date sorts last; the same file attached to two loops once.
	public static func pages(from outputs: [(loop: String, output: LoopOutput)]) -> [(loop: String, output: LoopOutput)] {
		var seen = Set<String>()
		return outputs.filter { $0.output.isHTML && seen.insert($0.output.id).inserted }
			.sorted { ($0.output.updatedAt ?? .distantPast) > ($1.output.updatedAt ?? .distantPast) }
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

/// The story row: the daily briefing first, then every HTML outcome of every loop, newest first.
@MainActor
@Observable
public final class StoriesStore {
	public private(set) var cards: [StoryCard] = []
	public private(set) var seenIDs: Set<String> = []
	/// True once `load()` has finished once, so a screen that shares the store loads it only if
	/// nobody has yet.
	public private(set) var hasLoaded = false

	@ObservationIgnored private let loops: any LoopsAPI
	@ObservationIgnored private let files: any FilesRemote
	@ObservationIgnored private let briefing: (any SpokenBriefing)?
	@ObservationIgnored private let seen: SeenStories
	@ObservationIgnored private let readerName: () -> String?
	@ObservationIgnored private let now: () -> Date

	public init(
		loops: any LoopsAPI, files: any FilesRemote, briefing: (any SpokenBriefing)?,
		seen: SeenStories = SeenStories(), readerName: @escaping () -> String? = { nil },
		now: @escaping () -> Date = Date.init
	) {
		self.loops = loops
		self.files = files
		self.briefing = briefing
		self.seen = seen
		self.readerName = readerName
		self.now = now
	}

	public func isSeen(_ card: StoryCard) -> Bool { seenIDs.contains(card.id) }

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
		let (brief, found) = await (spoken, pages)
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
		hasLoaded = true
		seenIDs = Set(next.filter { seen.isSeen($0) }.map(\.id))
	}

	private func loadBriefing() async -> SpokenBrief? {
		guard let briefing else { return nil }
		return try? await briefing.spokenBrief()
	}

	private func loadPages() async -> [StoryCard] {
		guard let all = try? await loops.loops() else { return [] }
		let loops = loops
		let found: [(loop: String, id: String, output: LoopOutput)] = await withTaskGroup(
			of: [(String, String, LoopOutput)].self
		) { group in
			for loop in all {
				group.addTask {
					let overview = try? await loops.overview(loopID: loop.id)
					return (overview?.outputs ?? []).map { (loop.name ?? "Loop", loop.id, $0) }
				}
			}
			var result: [(String, String, LoopOutput)] = []
			for await part in group { result += part }
			return result
		}.map { (loop: $0.0, id: $0.1, output: $0.2) }
		let loopOfOutput = Dictionary(
			found.map { ($0.output.id, $0.id) }, uniquingKeysWith: { first, _ in first })
		let outputs = found.map { (loop: $0.loop, output: $0.output) }
		let chosen = StoryDerivation.pages(from: outputs)
		let files = files
		return await withTaskGroup(of: (Int, StoryCard).self) { group in
			for (index, item) in chosen.enumerated() {
				group.addTask {
					let html = try? await files.file(id: item.output.id).text
					return (
						index,
						StoryCard(
							id: item.output.id, unit: item.loop,
							headline: StoryDerivation.headline(html: html, fileName: item.output.name),
							updatedAt: item.output.updatedAt, content: .page(item.output),
							loopID: loopOfOutput[item.output.id]))
				}
			}
			var result: [(Int, StoryCard)] = []
			for await part in group { result.append(part) }
			return result.sorted { $0.0 < $1.0 }.map(\.1)
		}
	}
}
