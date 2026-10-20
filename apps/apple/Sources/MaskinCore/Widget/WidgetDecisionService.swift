import Foundation
import MaskinAPI

// A decision made from the medium widget. The widget extension has no app and no outbox, so the
// shape is: write a HELD record, show "You chose X" with Undo, wait `undoWindow` seconds inside the
// intent, then send. Undo inside the window cancels the record before anything leaves the device.
//
// The server has no delete-comment endpoint (see `DecisionService`), so Undo after the send would be
// a lie: the window is short, and the widget only offers Undo while the record is held.
//
// If the extension is killed mid-window the record stays `held` and `flushDue` sends it on the
// next timeline load; a record stuck `sending` is retried under the same idempotency key, so a
// replay can never post the answer twice.

/// One answer the reader gave from the widget.
public struct WidgetDecisionRecord: Codable, Sendable, Equatable, Identifiable {
	public enum Phase: String, Codable, Sendable {
		/// Inside the Undo window: nothing has been sent.
		case held
		case sending
		case sent
		case failed
	}

	public var objectId: String
	public var workspaceId: String
	public var title: String
	public var label: String
	public var agentName: String?
	public var eventId: Int
	public var decidedAt: Date
	public var sendAt: Date
	public var phase: Phase
	/// Plain words for a failure; shown on the widget.
	public var message: String?
	public var id: String { objectId }

	public init(
		objectId: String, workspaceId: String, title: String, label: String, agentName: String?,
		eventId: Int, decidedAt: Date, sendAt: Date, phase: Phase = .held, message: String? = nil
	) {
		self.objectId = objectId
		self.workspaceId = workspaceId
		self.title = title
		self.label = label
		self.agentName = agentName
		self.eventId = eventId
		self.decidedAt = decidedAt
		self.sendAt = sendAt
		self.phase = phase
		self.message = message
	}

	/// How long the "You chose" card stays up. A failure is shorter: it asks for action, not memory.
	public func isShown(at date: Date) -> Bool {
		date.timeIntervalSince(decidedAt) < (phase == .failed ? WidgetDecisionService.failureDisplay : WidgetDecisionService.display)
	}

	/// The card hides its decision from the list while the answer is on its way or sent.
	public var hidesDecision: Bool { phase != .failed }

	public func canUndo(at date: Date) -> Bool { phase == .held && date < sendAt }
}

public protocol WidgetDecisionStore: Sendable {
	/// Read-modify-write under one lock, so a concurrent Undo and send cannot lose each other.
	@discardableResult
	func update<T>(_ body: (inout [WidgetDecisionRecord]) -> T) -> T
}

extension WidgetDecisionStore {
	public func records() -> [WidgetDecisionRecord] { update { $0 } }
}

public final class InMemoryWidgetDecisionStore: WidgetDecisionStore, @unchecked Sendable {
	private let lock = NSLock()
	private var value: [WidgetDecisionRecord]
	public init(_ value: [WidgetDecisionRecord] = []) { self.value = value }
	public func update<T>(_ body: (inout [WidgetDecisionRecord]) -> T) -> T {
		lock.withLock { body(&value) }
	}
}

/// A small JSON file in the extension's own container, like the snapshot cache.
public final class FileWidgetDecisionStore: WidgetDecisionStore, @unchecked Sendable {
	public let fileURL: URL
	private let lock = NSLock()

	public init(fileURL: URL = FileWidgetDecisionStore.defaultFileURL()) { self.fileURL = fileURL }

	public static func defaultFileURL(fileManager: FileManager = .default) -> URL {
		let base =
			fileManager.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
			?? fileManager.temporaryDirectory
		return base.appendingPathComponent("widget-decisions.json")
	}

	public func update<T>(_ body: (inout [WidgetDecisionRecord]) -> T) -> T {
		lock.withLock {
			var records = load()
			let before = records
			let result = body(&records)
			if records != before { save(records) }
			return result
		}
	}

	private func load() -> [WidgetDecisionRecord] {
		guard let data = try? Data(contentsOf: fileURL) else { return [] }
		return (try? Self.decoder.decode([WidgetDecisionRecord].self, from: data)) ?? []
	}

	private func save(_ records: [WidgetDecisionRecord]) {
		guard let data = try? Self.encoder.encode(records) else { return }
		try? FileManager.default.createDirectory(
			at: fileURL.deletingLastPathComponent(), withIntermediateDirectories: true)
		var options: Data.WritingOptions = [.atomic]
		#if os(iOS)
			options.insert(.completeFileProtectionUntilFirstUserAuthentication)
		#endif
		try? data.write(to: fileURL, options: options)
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

public struct WidgetDecisionService: Sendable {
	/// Seconds a widget answer is held before it is sent, during which Undo is free.
	public static let undoWindow: TimeInterval = 8
	/// How long a "You chose" card stays on the widget, and a failure card.
	public static let display: TimeInterval = 60 * 60
	public static let failureDisplay: TimeInterval = 5 * 60
	/// A record stuck in `sending` this long was killed mid-request: try it again.
	static let sendingStale: TimeInterval = 60

	public typealias Sender = @Sendable (WidgetDecisionRecord) async -> NotificationActionOutcome

	private let store: any WidgetDecisionStore
	private let send: Sender
	private let now: @Sendable () -> Date
	private let undoWindow: TimeInterval
	private let sleep: @Sendable (TimeInterval) async -> Void

	public init(
		store: any WidgetDecisionStore, undoWindow: TimeInterval = WidgetDecisionService.undoWindow,
		now: @escaping @Sendable () -> Date = { Date() },
		sleep: @escaping @Sendable (TimeInterval) async -> Void = { seconds in
			try? await Task.sleep(nanoseconds: UInt64(max(0, seconds) * 1_000_000_000))
		},
		send: @escaping Sender
	) {
		self.store = store
		self.undoWindow = undoWindow
		self.now = now
		self.sleep = sleep
		self.send = send
	}

	/// Records the answer as held. Returns `nil` when this decision cannot be answered in place
	/// (no event id, Hold, or a confirm option) or one is already recorded for it.
	@discardableResult
	public func choose(_ decision: WidgetSnapshot.Decision, label: String, workspaceId: String)
		-> WidgetDecisionRecord?
	{
		guard decision.decidesInPlace(label), let eventId = decision.eventId else { return nil }
		let at = now()
		let record = WidgetDecisionRecord(
			objectId: decision.objectId, workspaceId: workspaceId, title: decision.title,
			label: label, agentName: decision.agentName, eventId: eventId, decidedAt: at,
			sendAt: at.addingTimeInterval(undoWindow))
		let inserted = store.update { records -> Bool in
			records.removeAll { !$0.isShown(at: at) }
			if records.contains(where: { $0.objectId == record.objectId && $0.phase != .failed }) { return false }
			records.removeAll { $0.objectId == record.objectId }
			records.append(record)
			return true
		}
		return inserted ? record : nil
	}

	/// Waits out the Undo window for `objectId`, then sends unless it was undone meanwhile.
	public func settle(objectId: String) async {
		guard let record = store.records().first(where: { $0.objectId == objectId }) else { return }
		let wait = record.sendAt.timeIntervalSince(now())
		if wait > 0 { await sleep(wait) }
		await sendIfDue(objectId: objectId)
	}

	/// Sends every answer whose window has passed (a previous run was killed before it could).
	public func flushDue() async {
		let at = now()
		let due = store.records().filter {
			($0.phase == .held && $0.sendAt <= at)
				|| ($0.phase == .sending && at.timeIntervalSince($0.sendAt) > Self.sendingStale)
		}
		for record in due { await sendIfDue(objectId: record.objectId) }
	}

	/// Takes the answer back. Only possible while it is held; returns whether anything was undone.
	@discardableResult
	public func undo(objectId: String) -> Bool {
		let at = now()
		return store.update { records -> Bool in
			guard let index = records.firstIndex(where: { $0.objectId == objectId }),
				records[index].canUndo(at: at)
			else { return false }
			records.remove(at: index)
			return true
		}
	}

	public func shown(at date: Date? = nil) -> [WidgetDecisionRecord] {
		let at = date ?? now()
		return store.records().filter { $0.isShown(at: at) }.sorted { $0.decidedAt > $1.decidedAt }
	}

	private func sendIfDue(objectId: String) async {
		let at = now()
		let claimed = store.update { records -> WidgetDecisionRecord? in
			guard let index = records.firstIndex(where: { $0.objectId == objectId }) else { return nil }
			let stuck = records[index].phase == .sending
				&& at.timeIntervalSince(records[index].sendAt) > Self.sendingStale
			guard (records[index].phase == .held && records[index].sendAt <= at) || stuck else { return nil }
			records[index].phase = .sending
			return records[index]
		}
		guard let claimed else { return }
		let outcome = await send(claimed)
		store.update { records in
			guard let index = records.firstIndex(where: { $0.objectId == objectId }),
				records[index].phase == .sending
			else { return }
			switch outcome {
			case .answered, .queued, .deferred: records[index].phase = .sent
			case .failed(let message):
				records[index].phase = .failed
				records[index].message = message
			case .notSignedIn:
				records[index].phase = .failed
				records[index].message = "Open Maskin and sign in to answer from the widget."
			}
		}
	}
}

extension WidgetState {
	/// The snapshot with answered decisions taken out (see `WidgetSnapshot.removing`).
	public func applying(_ records: [WidgetDecisionRecord]) -> WidgetState {
		guard case .content(let snapshot) = self else { return self }
		let hidden = Set(records.filter(\.hidesDecision).map(\.objectId))
		return .content(snapshot.removing(objectIds: hidden))
	}
}

extension NotificationActionHandler {
	/// Production wiring for the widget extension: the same write as a notification button, but
	/// with no offline queue (the extension's container is not the app's outbox), so a write that
	/// cannot go out fails plainly and the card says so.
	public static func widget(baseURL: URL, secrets: any SecretStore) -> NotificationActionHandler {
		let backend: BackendFactory = { session, workspaceId in
			let client = MaskinClient.make(
				serverURL: baseURL, clientSource: "ios",
				credentials: { MaskinCredentials(apiKey: session.apiKey, workspaceId: workspaceId) })
			return APIForYouBackend(client: client, workspaceId: { workspaceId })
		}
		return NotificationActionHandler(secrets: secrets, backend: backend, queue: NoDecisionQueue())
	}
}

struct NoDecisionQueue: DecisionQueueing {
	struct Unavailable: Error {}
	func enqueue(_ write: QueuedDecision) async throws { throw Unavailable() }
}

extension WidgetDecisionService {
	/// Sends through `NotificationActionHandler`, which already derives the idempotency key from
	/// (workspace, object, event, answer).
	public static func production(baseURL: URL, secrets: any SecretStore, store: any WidgetDecisionStore)
		-> WidgetDecisionService
	{
		let handler = NotificationActionHandler.widget(baseURL: baseURL, secrets: secrets)
		return WidgetDecisionService(store: store) { record in
			await handler.perform(
				.option(label: record.label), userText: nil,
				payload: PushDecisionPayload(
					workspaceId: record.workspaceId, notificationId: "widget", eventId: record.eventId,
					objectId: record.objectId, options: [PushDecisionOption(label: record.label)]))
		}
	}
}
