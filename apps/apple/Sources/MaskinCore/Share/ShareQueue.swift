import Foundation

/// A share the extension could not send (offline, server down) and parked for the app to finish.
/// Plain data: everything needed to rebuild the `ShareRequest`, plus the idempotency base so the
/// app's retry can never duplicate something the extension already created.
public struct PendingShare: Codable, Sendable, Equatable, Identifiable {
	public struct Attachment: Codable, Sendable, Equatable {
		public var id: UUID
		public var kind: String
		public var name: String
		public var mimeType: String
		/// Name of the parked copy inside this share's folder.
		public var storedName: String
		public var sizeBytes: Int
	}

	public var id: UUID
	public var createdAt: Date
	public var workspaceId: String
	public var destination: Destination
	public var title: String
	public var note: String
	public var status: String
	public var link: URL?
	public var linkTitle: String?
	public var text: String?
	public var attachments: [Attachment]
	public var idempotencyBase: String

	/// `ShareDestination` as stable JSON (an enum with payloads would tie the on-disk format to
	/// Swift's synthesized layout).
	public struct Destination: Codable, Sendable, Equatable {
		public var kind: String
		public var value: String?
	}
}

extension PendingShare.Destination {
	init(_ destination: ShareDestination) {
		switch destination {
		case .object(let type): self.init(kind: "object", value: type)
		case .filesOnly: self.init(kind: "files", value: nil)
		case .chat(let id): self.init(kind: "chat", value: id)
		}
	}

	var destination: ShareDestination? {
		switch kind {
		case "object": value.map { .object(type: $0) }
		case "files": .filesOnly
		case "chat": value.map { .chat(id: $0) }
		default: nil
		}
	}
}

/// A folder of parked shares shared between the extension (writes) and the app (drains) through
/// the App Group container. One folder per share: `share.json` plus the attachment files, so a
/// share is added or removed as a unit and a crash mid-write leaves nothing half-readable.
///
/// Holds the user's content on disk until it is sent, so it is bounded (count and age) and its
/// folder is excluded from backups.
public struct ShareQueue: Sendable {
	/// App Group both targets declare in their entitlements (see docs/push-and-links.md).
	public static let appGroupIdentifier = "group.io.maskin.app"
	public static let maxPending = 20
	public static let maxAge: TimeInterval = 14 * 24 * 60 * 60

	public let root: URL

	public init(root: URL) { self.root = root }

	/// The queue in the App Group container, or `nil` when this build isn't signed with the group
	/// (the extension then reports the failure instead of pretending to have saved).
	public static func shared() -> ShareQueue? {
		FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroupIdentifier)
			.map { ShareQueue(root: $0.appendingPathComponent("ShareQueue", isDirectory: true)) }
	}

	private var fm: FileManager { .default }

	/// Parks `request` for later. Copies the attachments in (the extension's temp files vanish
	/// with it). Throws `ShareError.unknown` when it can't be stored or the queue is full.
	@discardableResult
	public func enqueue(
		_ request: ShareRequest, workspaceId: String, idempotencyBase: String, now: Date = Date()
	) throws(ShareError) -> PendingShare {
		purgeExpired(now: now)
		guard pending().count < Self.maxPending else { throw .queueFull }
		let id = UUID()
		let folder = folder(for: id)
		do {
			try fm.createDirectory(at: folder, withIntermediateDirectories: true)
			var attachments: [PendingShare.Attachment] = []
			for attachment in request.content.attachments {
				let storedName = attachment.id.uuidString
				try fm.copyItem(at: attachment.fileURL, to: folder.appendingPathComponent(storedName))
				attachments.append(
					.init(
						id: attachment.id, kind: Self.kindName(attachment.kind), name: attachment.name,
						mimeType: attachment.mimeType, storedName: storedName, sizeBytes: attachment.sizeBytes))
			}
			let share = PendingShare(
				id: id, createdAt: now, workspaceId: workspaceId, destination: .init(request.destination),
				title: request.title, note: request.note, status: request.status,
				link: request.content.link, linkTitle: request.content.linkTitle,
				text: request.content.text, attachments: attachments, idempotencyBase: idempotencyBase)
			let data = try JSONEncoder().encode(share)
			try data.write(to: folder.appendingPathComponent("share.json"), options: .atomic)
			var excluded = URLResourceValues()
			excluded.isExcludedFromBackup = true
			var mutable = folder
			try? mutable.setResourceValues(excluded)
			return share
		} catch {
			try? fm.removeItem(at: folder)
			throw .queueUnavailable
		}
	}

	/// Parked shares, oldest first. Folders that can't be read are skipped.
	public func pending() -> [PendingShare] {
		let folders = (try? fm.contentsOfDirectory(at: root, includingPropertiesForKeys: nil)) ?? []
		return folders.compactMap { folder in
			guard let data = try? Data(contentsOf: folder.appendingPathComponent("share.json")) else { return nil }
			return try? JSONDecoder().decode(PendingShare.self, from: data)
		}.sorted { $0.createdAt < $1.createdAt }
	}

	/// The `ShareRequest` for a parked share; its attachment files are the parked copies.
	/// `nil` when the share is unusable (unknown destination, missing file).
	public func request(for share: PendingShare) -> ShareRequest? {
		guard let destination = share.destination.destination else { return nil }
		var attachments: [ShareAttachment] = []
		for stored in share.attachments {
			let url = folder(for: share.id).appendingPathComponent(stored.storedName)
			guard fm.fileExists(atPath: url.path) else { return nil }
			attachments.append(
				ShareAttachment(
					id: stored.id, kind: Self.kind(stored.kind), name: stored.name, mimeType: stored.mimeType,
					fileURL: url, sizeBytes: stored.sizeBytes))
		}
		let content = ShareContent(
			link: share.link, linkTitle: share.linkTitle, text: share.text, attachments: attachments)
		return ShareRequest(
			destination: destination, title: share.title, note: share.note, content: content,
			status: share.status)
	}

	public func remove(_ id: UUID) { try? fm.removeItem(at: folder(for: id)) }

	/// Drops shares older than `maxAge`, and folders with no readable manifest.
	public func purgeExpired(now: Date = Date()) {
		let folders = (try? fm.contentsOfDirectory(at: root, includingPropertiesForKeys: nil)) ?? []
		for folder in folders {
			let share = (try? Data(contentsOf: folder.appendingPathComponent("share.json")))
				.flatMap { try? JSONDecoder().decode(PendingShare.self, from: $0) }
			if share == nil || now.timeIntervalSince(share!.createdAt) > Self.maxAge {
				try? fm.removeItem(at: folder)
			}
		}
	}

	private func folder(for id: UUID) -> URL { root.appendingPathComponent(id.uuidString, isDirectory: true) }

	private static func kindName(_ kind: ShareAttachment.Kind) -> String {
		switch kind {
		case .image: "image"
		case .pdf: "pdf"
		case .file: "file"
		}
	}

	private static func kind(_ name: String) -> ShareAttachment.Kind {
		switch name {
		case "image": .image
		case "pdf": .pdf
		default: .file
		}
	}
}

/// Sends parked shares from the main app. Idempotent end to end: each share keeps the base its
/// Idempotency-Keys were derived from, so a retry after a lost response never duplicates.
public struct ShareQueueDrainer: Sendable {
	public struct Report: Sendable, Equatable {
		public var sent = 0
		/// Refused for good (4xx) or unusable: removed so they can't block the queue.
		public var dropped = 0
		public var remaining = 0
	}

	private let queue: ShareQueue
	private let makeRemote: @Sendable (ShareCredentials) -> any ShareRemote

	public init(queue: ShareQueue, makeRemote: @escaping @Sendable (ShareCredentials) -> any ShareRemote) {
		self.queue = queue
		self.makeRemote = makeRemote
	}

	/// Works oldest first and stops at the first failure that a later try could fix (offline,
	/// server error, expired session), keeping that share and everything after it.
	public func drain(apiKey: String) async -> Report {
		queue.purgeExpired()
		var report = Report()
		let all = queue.pending()
		for (index, share) in all.enumerated() {
			guard let request = queue.request(for: share) else {
				queue.remove(share.id)
				report.dropped += 1
				continue
			}
			let remote = makeRemote(ShareCredentials(apiKey: apiKey, workspaceId: share.workspaceId))
			let poster = SharePoster(remote: remote, idempotencyBase: share.idempotencyBase)
			do {
				_ = try await poster.post(request)
				queue.remove(share.id)
				report.sent += 1
			} catch let error as ShareError where error.isTransient || error.needsApp {
				return finish(report)
			} catch {
				// Refused for good: keeping it would block everything behind it.
				queue.remove(share.id)
				report.dropped += 1
			}
		}
		return finish(report)
	}

	private func finish(_ report: Report) -> Report {
		var report = report
		report.remaining = queue.pending().count
		return report
	}
}
