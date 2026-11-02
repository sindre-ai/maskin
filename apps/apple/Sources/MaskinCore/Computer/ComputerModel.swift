import Foundation
import Observation

/// What the bundled page reports about the stream.
public enum ComputerPageEvent: Equatable, Sendable {
	case connected
	case disconnected

	public init?(name: String) {
		switch name {
		case "connect": self = .connected
		case "disconnect": self = .disconnected
		default: return nil
		}
	}
}

/// One address and password for the page to open. Secret: never printed. A new value (new `id`) is
/// a new connection, so the page reconnects exactly when a fresh ticket arrives.
public struct ComputerStream: Equatable, Sendable, Identifiable, CustomStringConvertible, CustomDebugStringConvertible {
	public let id = UUID()
	public let url: URL
	public let password: String

	public static func == (lhs: ComputerStream, rhs: ComputerStream) -> Bool { lhs.id == rhs.id }

	public var description: String { "ComputerStream(redacted)" }
	public var debugDescription: String { description }
}

/// The Computer screen's state, mirroring the web viewer: Starting, Connecting, Live, Idle, Error.
/// It watches only until the person takes over, and it never reconnects on its own: Wake up and
/// Reconnect are the only ways to ask for a new ticket.
@MainActor
@Observable
public final class ComputerModel {
	public enum Phase: Equatable, Sendable {
		/// Asking the server for a ticket; the first start of a computer can take up to a minute.
		case starting
		case connecting
		case live
		/// The stream closed after being live, or the app was in the background.
		case idle
		case failed(String)
	}

	public private(set) var phase: Phase = .starting
	public private(set) var stream: ComputerStream?
	public private(set) var controlling = false
	/// Bumped to ask the page to raise the keyboard.
	public private(set) var keyboardRequests = 0

	private let agentID: String?
	private let baseURL: URL
	private let connector: any DesktopConnecting
	@ObservationIgnored private var attempt = 0
	@ObservationIgnored private var task: Task<Void, Never>?
	@ObservationIgnored private var started = false

	public init(agentID: String?, baseURL: URL, connector: any DesktopConnecting) {
		self.agentID = agentID
		self.baseURL = baseURL
		self.connector = connector
	}

	/// Opens the computer once, when the screen first appears.
	public func startIfNeeded() {
		guard !started else { return }
		connect()
	}

	/// Asks for a fresh ticket and opens the stream. Used by the first open, Wake up and Reconnect.
	public func connect() {
		started = true
		attempt += 1
		let mine = attempt
		task?.cancel()
		stream = nil
		controlling = false
		phase = .starting
		task = Task { [weak self] in await self?.run(attempt: mine) }
	}

	private func run(attempt mine: Int) async {
		do {
			let ticket = try await connector.connect(agentID: agentID)
			guard mine == attempt else { return }
			guard let url = ticket.streamURL(base: baseURL) else {
				phase = .failed(DesktopConnectError.server(status: 0).message)
				return
			}
			phase = .connecting
			stream = ComputerStream(url: url, password: ticket.password)
		} catch is CancellationError {
		} catch {
			guard mine == attempt else { return }
			phase = .failed((error as? DesktopConnectError)?.message ?? DesktopConnectError.network.message)
		}
	}

	public func handle(_ event: ComputerPageEvent) {
		// Anything from a stream we already dropped is stale.
		guard stream != nil else { return }
		switch event {
		case .connected:
			phase = .live
		case .disconnected:
			let wasLive = phase == .live
			stream = nil
			controlling = false
			// A closed live stream is an idle computer going to sleep, not a fault.
			phase = wasLive ? .idle : .failed("Couldn't connect to the desktop.")
		}
	}

	public func setControlling(_ on: Bool) {
		guard phase == .live else { return }
		controlling = on
		if on { keyboardRequests += 1 }
	}

	public func showKeyboard() {
		guard phase == .live, controlling else { return }
		keyboardRequests += 1
	}

	/// The app left the foreground: the socket is gone. Show Idle and wait for Wake up.
	public func enteredBackground() {
		guard started else { return }
		drop()
		phase = .idle
	}

	/// The screen closed.
	public func close() {
		drop()
	}

	private func drop() {
		attempt += 1
		task?.cancel()
		task = nil
		stream = nil
		controlling = false
	}
}
