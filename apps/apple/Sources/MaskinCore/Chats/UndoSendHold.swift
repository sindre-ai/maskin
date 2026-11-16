import Foundation
import Observation

/// Undo send. `hold` keeps a message in the app for `window` and delivers nothing until the window
/// ends, so an undone message is never queued, saved as sent or seen by an agent. Holding another
/// message, leaving the screen or sending the app to the background delivers the held one at once:
/// it is never dropped and never reordered.
///
/// `send` and `restore` run on the main actor. `send` is synchronous on purpose: it queues the
/// message (or starts the request), so two flushes in a row keep their order.
@MainActor
@Observable
public final class UndoSendHold {
	public static let window: Duration = .seconds(5)

	/// A message is waiting out its window: the Undo bar is up.
	public private(set) var isHeld = false

	private struct Held {
		var send: @MainActor () -> Void
		var restore: @MainActor () -> Void
	}

	@ObservationIgnored private var held: Held?
	@ObservationIgnored private var timer: Task<Void, Never>?
	@ObservationIgnored private var generation = 0
	@ObservationIgnored private let window: Duration
	@ObservationIgnored private let sleep: @Sendable (Duration) async throws -> Void

	public init(
		window: Duration = UndoSendHold.window,
		sleep: @escaping @Sendable (Duration) async throws -> Void = { try await Task.sleep(for: $0) }
	) {
		self.window = window
		self.sleep = sleep
	}

	/// Starts the window. A message already held goes out first.
	public func hold(
		send: @escaping @MainActor () -> Void, restore: @escaping @MainActor () -> Void
	) {
		flush()
		held = Held(send: send, restore: restore)
		isHeld = true
		generation += 1
		let mine = generation
		timer = Task { [weak self, window, sleep] in
			do { try await sleep(window) } catch { return }
			guard let self, self.generation == mine else { return }
			self.flush()
		}
	}

	/// Takes the held message back: its `restore` runs and nothing is delivered.
	public func undo() {
		take()?.restore()
	}

	/// Delivers the held message now. Safe to call with nothing held.
	public func flush() {
		take()?.send()
	}

	private func take() -> Held? {
		timer?.cancel()
		timer = nil
		generation += 1
		let taken = held
		held = nil
		isHeld = false
		return taken
	}
}
