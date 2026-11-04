import Foundation
import Observation

/// What the log view shows.
public enum SessionLogFilter: String, CaseIterable, Identifiable, Sendable {
	case readable = "Readable"
	case raw = "Raw"
	case problems = "Problems"
	public var id: String { rawValue }
}

/// A session's log: the newest rows first, older pages on demand, and while the session is alive
/// a poll for rows newer than the last one held. The live stream (`/logs/stream`) is not in the
/// OpenAPI snapshot, so the generated client cannot reach it; polling `since` reads the same rows.
@MainActor
@Observable
public final class SessionLogsStore {
	public enum Phase: Equatable, Sendable { case idle, loading, loaded, failed(String) }

	static let pageSize = 200
	/// Rows kept in memory; the oldest drop first.
	static let maxRows = 3000

	public private(set) var phase: Phase = .idle
	/// Ascending by id.
	public private(set) var rows: [SessionLogRow] = []
	public private(set) var hasOlder = false
	public private(set) var loadingOlder = false
	public private(set) var live = false
	/// A failed poll or page, shown over the rows already loaded.
	public private(set) var notice: String?
	public var filter: SessionLogFilter = .readable

	@ObservationIgnored private let sessionID: String
	@ObservationIgnored private let api: any SessionLogsAPI
	@ObservationIgnored private let pollInterval: Duration
	@ObservationIgnored nonisolated(unsafe) private var poller: Task<Void, Never>?

	public init(sessionID: String, api: any SessionLogsAPI, pollInterval: Duration = .seconds(2)) {
		self.sessionID = sessionID
		self.api = api
		self.pollInterval = pollInterval
	}

	deinit { poller?.cancel() }

	// MARK: - Reading

	public var lines: [SessionLogLine] { rows.flatMap(SessionLogLine.lines(from:)) }

	/// Rows for the Raw and Problems tabs.
	public var visibleRows: [SessionLogRow] {
		switch filter {
		case .readable, .raw: rows
		case .problems: rows.filter { $0.stream == "stderr" || Self.isFailureEnvelope($0.content) }
		}
	}

	static func isFailureEnvelope(_ content: String) -> Bool {
		content.contains("\"is_error\":true") || content.contains("\"is_error\": true")
	}

	// MARK: - Loading

	/// Load the newest page, then follow the tail while `live`.
	public func start(live: Bool) async {
		self.live = live
		if rows.isEmpty { phase = .loading }
		await loadNewest()
		syncPoller()
	}

	/// The session's status changed (it finished, or was resumed).
	public func setLive(_ live: Bool) async {
		guard self.live != live else { return }
		self.live = live
		syncPoller()
		// One last read so rows written as it finished are not missed.
		if !live { await pollOnce() }
	}

	public func stop() {
		poller?.cancel()
		poller = nil
	}

	public func refresh() async {
		if phase == .loaded { await pollOnce() } else { await loadNewest() }
	}

	private func loadNewest() async {
		do {
			let page = try await api.logs(
				sessionID: sessionID, query: .init(order: .descending, limit: Self.pageSize))
			rows = page.sorted { $0.id < $1.id }
			hasOlder = page.count >= Self.pageSize
			notice = nil
			phase = .loaded
		} catch {
			if rows.isEmpty { phase = .failed(Self.message(error)) } else { notice = Self.message(error) }
		}
	}

	public func loadOlder() async {
		guard hasOlder, !loadingOlder, let oldest = rows.first else { return }
		loadingOlder = true
		defer { loadingOlder = false }
		do {
			let page = try await api.logs(
				sessionID: sessionID,
				query: .init(before: oldest.id, order: .descending, limit: Self.pageSize))
			let known = Set(rows.map(\.id))
			rows = (page.filter { !known.contains($0.id) } + rows).sorted { $0.id < $1.id }
			hasOlder = page.count >= Self.pageSize
		} catch {
			notice = Self.message(error)
		}
	}

	/// Rows newer than the newest held. Pages until caught up.
	func pollOnce() async {
		guard phase == .loaded else { return }
		var cursor = rows.last?.id
		do {
			for _ in 0..<5 {
				let page = try await api.logs(
					sessionID: sessionID, query: .init(since: cursor, order: .ascending, limit: Self.pageSize))
				let known = Set(rows.suffix(Self.pageSize).map(\.id))
				rows.append(contentsOf: page.filter { !known.contains($0.id) }.sorted { $0.id < $1.id })
				guard page.count >= Self.pageSize, let newest = page.last else { break }
				cursor = newest.id
			}
			if rows.count > Self.maxRows {
				rows = Array(rows.suffix(Self.maxRows))
				hasOlder = true
			}
			notice = nil
		} catch {
			notice = Self.message(error)
		}
	}

	private func syncPoller() {
		poller?.cancel()
		poller = nil
		guard live, phase == .loaded else { return }
		let interval = pollInterval
		poller = Task { [weak self] in
			while !Task.isCancelled {
				try? await Task.sleep(for: interval)
				if Task.isCancelled { break }
				await self?.pollOnce()
			}
		}
	}

	private static func message(_ error: Error) -> String {
		(error as? SessionLogsError)?.message ?? "Couldn't load the log."
	}
}
