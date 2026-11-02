import Foundation
import Testing

@testable import MaskinCore

/// `deinit` runs on whichever thread drops the last reference. A `MainActor.assumeIsolated` in it
/// traps (SIGTRAP) off the main queue; these drop the last reference on a background queue.
@Suite("Deinit off the main thread")
struct DeinitOffMainTests {
	private final class Box: @unchecked Sendable {
		var value: AnyObject?
		init(_ value: AnyObject) { self.value = value }
	}

	private func dropOffMain(_ object: AnyObject) async {
		let box = Box(object)
		await withCheckedContinuation { (done: CheckedContinuation<Void, Never>) in
			DispatchQueue.global().async {
				box.value = nil
				done.resume()
			}
		}
	}

	@Test("ChatComposerModel can be released from a background queue")
	@MainActor
	func composer() async {
		let model = ChatComposerModel(uploader: nil, selfActorID: "me")
		await dropOffMain(model)
	}
}
