import Foundation
import MaskinCore
import Observation

/// One custom view on the loop page: loads the HTML file, answers the view's declared questions
/// with the viewer's own session, and keeps the numbers live while the tab is open.
///
/// The page never sees a credential. It asks by name, the model runs the query it declared, and
/// the answer goes back into the page. Every 30 seconds the model asks again; if a number moved,
/// the page is replaced by a fresh one that is handed the new answers (the web view does the same).
@MainActor
@Observable
final class LoopCustomViewModel {
	enum Phase: Equatable {
		case loading, ready
		case failed(String)
	}

	/// Smallest the view is drawn, so an empty page still shows as a card.
	static let minHeight: Double = 160
	static let refreshEvery: Duration = .seconds(30)

	private(set) var phase: Phase = .loading
	/// The page to load, policy included; nil until the file is read and checked.
	private(set) var document: String?
	/// Bumps whenever the page must be loaded again (first load, new numbers, a crashed web process).
	private(set) var generation = 0
	private(set) var height = LoopCustomViewModel.minHeight
	/// When the oldest answer on screen was fetched.
	private(set) var updatedAt: Date?
	/// A question the page asked failed. The page gets the error itself; this note shows it even if
	/// the page draws no error state.
	private(set) var queryFailed = false
	/// A check for new numbers failed.
	private(set) var refreshFailed = false
	/// An answer hit the server's size limit, so its counts may be low.
	private(set) var partial = false

	@ObservationIgnored private let fileID: String
	@ObservationIgnored private let files: any FilesRemote
	@ObservationIgnored private let queries: any LoopDataQuerying
	@ObservationIgnored private let now: @Sendable () -> Date
	@ObservationIgnored private var sources: [String: JSONValue] = [:]
	/// What the page on screen was last told, by query.
	@ObservationIgnored private var given: [String: JSONValue] = [:]
	/// A newer answer the next page is given as it is, once, by query.
	@ObservationIgnored private var fresh: [String: JSONValue] = [:]
	@ObservationIgnored private var answeredAt: [String: Date] = [:]
	@ObservationIgnored private var inFlight = 0

	init(
		fileID: String, files: any FilesRemote, queries: any LoopDataQuerying,
		now: @escaping @Sendable () -> Date = { Date() }
	) {
		self.fileID = fileID
		self.files = files
		self.queries = queries
		self.now = now
	}

	// MARK: Loading

	/// Reads the file and checks it can be shown. Says why in plain words when it cannot.
	func load() async {
		phase = .loading
		document = nil
		given = [:]
		fresh = [:]
		answeredAt = [:]
		updatedAt = nil
		queryFailed = false
		refreshFailed = false
		partial = false
		height = Self.minHeight
		let file: FileDetail
		do {
			file = try await files.file(id: fileID)
		} catch {
			phase = .failed("Couldn't load this view. Check your connection and try again.")
			return
		}
		guard file.mimeType.lowercased().hasPrefix("text/html") else {
			phase = .failed("This view's file is not an HTML page.")
			return
		}
		guard let html = String(data: file.data, encoding: .utf8) else {
			phase = .failed("This view's file could not be read.")
			return
		}
		switch LoopViewBridge.readSources(from: html) {
		case .invalid(let reason):
			phase = .failed(reason)
		case .ok(let declared):
			sources = declared
			let page = await Task.detached(priority: .userInitiated) { MiniAppHTML.prepareView(html) }.value
			document = page
			generation += 1
			phase = .ready
		}
	}

	// MARK: The page's questions

	/// The answer to one question the page asked, by source name.
	func answer(name: String) async -> LoopViewBridge.Reply {
		guard inFlight < LoopViewBridge.maxInFlight else {
			return .error("Too many questions at once.")
		}
		inFlight += 1
		defer { inFlight -= 1 }
		let reply = await LoopViewBridge.answer(name: name, sources: sources) { [self] spec in
			try await resolve(spec)
		}
		if case .error = reply, sources[name] != nil { queryFailed = true }
		return reply
	}

	private func resolve(_ spec: JSONValue) async throws -> JSONValue {
		let key = LoopViewBridge.canonical(spec)
		// A refresh just found a different number; the new page gets that one.
		if let latest = fresh.removeValue(forKey: key) {
			record(latest, for: key)
			return latest
		}
		let result = try await queries.run(spec)
		record(result, for: key)
		return result
	}

	private func record(_ result: JSONValue, for key: String) {
		given[key] = result
		answeredAt[key] = now()
		updatedAt = answeredAt.values.min()
		if case .bool(true)? = result["rows_truncated"] { partial = true }
		if case .bool(true)? = result["groups_truncated"] { partial = true }
	}

	func sizeChanged(_ newHeight: Double) {
		height = max(Self.minHeight, newHeight.rounded(.up))
	}

	/// The web process behind the page stopped; load it again.
	func reload() {
		guard document != nil else { return }
		generation += 1
	}

	// MARK: Staying current

	/// Asks every question the page has asked again. If any answer differs, the page is replaced by
	/// a fresh one that is handed the new answers. Called every `refreshEvery` while the tab is open.
	func refresh() async {
		guard phase == .ready else { return }
		var changed = false
		var failed = false
		var seen = Set<String>()
		for spec in sources.values {
			let key = LoopViewBridge.canonical(spec)
			// Only what the page has asked for; a source it never used costs nothing.
			guard seen.insert(key).inserted, let before = given[key] else { continue }
			do {
				let latest = try await queries.run(spec)
				answeredAt[key] = now()
				if latest != before {
					fresh[key] = latest
					changed = true
				}
			} catch {
				failed = true
			}
		}
		updatedAt = answeredAt.values.min()
		refreshFailed = failed
		if changed {
			queryFailed = false
			partial = false
			generation += 1
		}
	}
}
