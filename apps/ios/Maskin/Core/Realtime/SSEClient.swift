import Foundation

/// A parsed frame from `GET /api/events`. Mirrors `apps/web/src/lib/sse.ts`'s `SSEEvent`.
struct SSEEvent {
	let id: Int?
	let event: String? // the entity `action`, e.g. "commented", "session_completed"
	let data: Data
}

/// Streams `GET /api/events` over `URLSession.bytes(for:)` — not `EventSource`, which
/// can't set the `Authorization`/`X-Workspace-Id` headers this endpoint requires (see
/// plan §4). Resumes via `Last-Event-ID` on reconnect.
actor SSEClient {
	private var lastEventId: Int?
	private var streamTask: Task<Void, Never>?

	func connect(workspaceId: String, onEvent: @escaping @Sendable (SSEEvent) -> Void) {
		streamTask?.cancel()
		streamTask = Task { [weak self] in
			await self?.run(workspaceId: workspaceId, onEvent: onEvent)
		}
	}

	func disconnect() {
		streamTask?.cancel()
		streamTask = nil
	}

	private func run(workspaceId: String, onEvent: @escaping @Sendable (SSEEvent) -> Void) async {
		while !Task.isCancelled {
			do {
				try await connectOnce(workspaceId: workspaceId, onEvent: onEvent)
			} catch {
				if Task.isCancelled { return }
			}
			// Backoff before reconnecting — the endpoint sends a 30s keepalive, so a
			// dropped connection is either a network blip or the app returning from
			// background; either way, a short delay avoids a hot retry loop.
			try? await Task.sleep(nanoseconds: 3_000_000_000)
		}
	}

	private func connectOnce(workspaceId: String, onEvent: @escaping @Sendable (SSEEvent) -> Void) async throws {
		var request = URLRequest(url: DevServer.eventsURL)
		request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
		request.setValue(workspaceId, forHTTPHeaderField: "X-Workspace-Id")
		if let apiKey = await AuthManager.shared.apiKey {
			request.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization")
		}
		if let lastEventId {
			request.setValue(String(lastEventId), forHTTPHeaderField: "Last-Event-ID")
		}

		let (bytes, _) = try await URLSession.shared.bytes(for: request)

		var currentId: Int?
		var currentEvent: String?
		var dataLines: [String] = []

		func flush() {
			guard !dataLines.isEmpty else { return }
			let payload = Data(dataLines.joined(separator: "\n").utf8)
			if let currentId { lastEventId = currentId }
			onEvent(SSEEvent(id: currentId, event: currentEvent, data: payload))
			currentId = nil
			currentEvent = nil
			dataLines = []
		}

		for try await line in bytes.lines {
			if Task.isCancelled { return }
			if line.isEmpty {
				flush()
				continue
			}
			if let value = line.dropPrefix("id:") {
				currentId = Int(value.trimmingCharacters(in: .whitespaces))
			} else if let value = line.dropPrefix("event:") {
				currentEvent = value.trimmingCharacters(in: .whitespaces)
			} else if let value = line.dropPrefix("data:") {
				dataLines.append(value.trimmingCharacters(in: .whitespaces))
			}
		}
	}
}

private extension String {
	func dropPrefix(_ prefix: String) -> String? {
		guard hasPrefix(prefix) else { return nil }
		return String(dropFirst(prefix.count))
	}
}
