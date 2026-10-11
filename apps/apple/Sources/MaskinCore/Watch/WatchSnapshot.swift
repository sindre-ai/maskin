import Foundation

/// Everything the watch shows, as plain values. The iPhone sends it over `WCSession`
/// (`applicationContext`) and the watch caches the last one, so the wrist is never blank offline.
/// Compact on purpose: application context is for small property lists.
public struct WatchSnapshot: Codable, Sendable, Equatable {
	public struct Card: Codable, Sendable, Equatable, Identifiable {
		public var id: String
		public var sender: String
		public var headline: String
		public var summary: String
		public var ask: String
		public var options: [DecisionOption]
		public var at: Date?

		public init(
			id: String, sender: String, headline: String, summary: String = "", ask: String = "",
			options: [DecisionOption] = [], at: Date? = nil
		) {
			self.id = id
			self.sender = sender
			self.headline = headline
			self.summary = summary
			self.ask = ask
			self.options = options
			self.at = at
		}
	}

	public struct Flow: Codable, Sendable, Equatable, Identifiable {
		public var id: String
		public var name: String
		public var progress: Double
		public var paused: Bool
		public var needsYou: Bool
		/// "Cycle 4 · Supervised": which turn of the loop, and its rung.
		public var cycleStage: String
		/// "Replies 12 of 20", the first target; nil when the flow has none.
		public var target: String?
		/// One sentence on the latest update.
		public var latest: String?

		public init(
			id: String, name: String, progress: Double, paused: Bool, needsYou: Bool,
			cycleStage: String, target: String? = nil, latest: String? = nil
		) {
			self.id = id
			self.name = name
			self.progress = progress
			self.paused = paused
			self.needsYou = needsYou
			self.cycleStage = cycleStage
			self.target = target
			self.latest = latest
		}
	}

	public var cards: [Card]
	public var flows: [Flow]
	/// The briefing as plain text (see `WatchBriefingText`); nil until one has loaded.
	public var briefing: String?
	public var firstName: String?
	public var updatedAt: Date

	public init(
		cards: [Card] = [], flows: [Flow] = [], briefing: String? = nil, firstName: String? = nil,
		updatedAt: Date
	) {
		self.cards = cards
		self.flows = flows
		self.briefing = briefing
		self.firstName = firstName
		self.updatedAt = updatedAt
	}

	public var needsCount: Int { cards.count }

	/// The flow the circular complication draws: one that needs you, else the first running one.
	public var topFlow: Flow? { flows.first(where: \.needsYou) ?? flows.first }

	static let contextKey = "maskin.watch.snapshot.v1"

	/// The `WCSession` application-context entry. Property-list types only.
	public func context() -> [String: Any] {
		guard let data = try? Self.encoder.encode(self) else { return [:] }
		return [Self.contextKey: data]
	}

	/// nil when the context carries no snapshot, or one this build can't read.
	public init?(context: [String: Any]) {
		guard let data = context[Self.contextKey] as? Data,
			let decoded = try? Self.decoder.decode(WatchSnapshot.self, from: data)
		else { return nil }
		self = decoded
	}

	private static let encoder: JSONEncoder = {
		let e = JSONEncoder()
		e.dateEncodingStrategy = .secondsSince1970
		return e
	}()
	private static let decoder: JSONDecoder = {
		let d = JSONDecoder()
		d.dateDecodingStrategy = .secondsSince1970
		return d
	}()
}

public enum WatchSnapshotBuilder {
	public static let maxCards = 8
	public static let maxFlows = 12

	/// From the feed and loops the iPhone (or a signed-in watch) already holds.
	public static func make(
		entries: [FeedEntry], sender: (ForYouCard) -> String?, briefMarkdown: String?,
		loops: [LoopSummary], firstName: String?, now: Date
	) -> WatchSnapshot {
		let cards = entries.filter { $0.section == .needs && $0.record == nil }.prefix(maxCards).map {
			entry -> WatchSnapshot.Card in
			let card = entry.card
			return WatchSnapshot.Card(
				id: card.id, sender: sender(card) ?? "Chief of Staff", headline: card.headline,
				summary: card.decision?.summary ?? "", ask: card.decision?.ask ?? "",
				options: card.decision?.options ?? [], at: card.latestActivityAt)
		}
		let flows = loops.filter { $0.status != .draft }.prefix(maxFlows).map(flow)
		return WatchSnapshot(
			cards: Array(cards), flows: Array(flows),
			briefing: briefMarkdown.map(WatchBriefingText.plain), firstName: firstName, updatedAt: now)
	}

	public static func flow(_ loop: LoopSummary) -> WatchSnapshot.Flow {
		let cycle = loop.closedCount + 1
		let target = loop.targets?.first.map {
			"\($0.label) \(format($0.actual)) of \(format($0.target))"
		}
		return WatchSnapshot.Flow(
			id: loop.id, name: loop.displayName, progress: loop.ringProgress, paused: loop.isPaused,
			needsYou: loop.waitingCount > 0, cycleStage: "Cycle \(cycle) \u{00B7} \(loop.status.label)",
			target: target, latest: loop.content.flatMap(latestSentence))
	}

	/// The first sentence of the flow's description: a watch has room for one.
	static func latestSentence(_ text: String) -> String? {
		let plain = WatchBriefingText.plain(text).replacingOccurrences(of: "\n", with: " ")
			.trimmingCharacters(in: .whitespaces)
		guard !plain.isEmpty else { return nil }
		if let end = plain.firstIndex(where: { ".!?".contains($0) }) { return String(plain[...end]) }
		return plain
	}

	private static func format(_ value: Double) -> String {
		value.rounded() == value ? String(Int(value)) : String(format: "%.1f", value)
	}
}
