import Foundation
import OpenAPIRuntime
import Testing

@testable import MaskinCore

/// The generated client wraps whatever a call threw in a `ClientError`, so a load cancelled by a
/// refresh arrives as "Client encountered an error ... CancellationError()", not a bare cancellation.
private func wrapped(_ underlying: any Error) -> ClientError {
	ClientError(
		operationID: "get/api/conversations/{id}/messages", operationInput: (),
		causeDescription: "Transport threw an error.", underlyingError: underlying)
}

@Suite("ChatStore cancelled loads")
@MainActor
struct ChatStoreCancelledLoadTests {
	@Test("a cancellation is recognised through the client's wrapper, a real failure is not")
	func recognisesWrappedCancellation() {
		#expect(RemoteFailure.isCancellation(CancellationError()))
		#expect(RemoteFailure.isCancellation(wrapped(CancellationError())))
		#expect(RemoteFailure.isCancellation(wrapped(URLError(.cancelled))))
		#expect(!RemoteFailure.isCancellation(wrapped(URLError(.notConnectedToInternet))))
		#expect(!RemoteFailure.isCancellation(ChatsError("Couldn't load messages.")))
	}

	@Test("a cancelled page of earlier messages shows no pop-up")
	func cancelledEarlierPageIsSilent() async {
		let h = ChatHarness(server: (1...7).map { chatMsg($0) }, pageSize: 3)
		await h.store.start()
		await h.api.setMessagesError(wrapped(CancellationError()))
		await h.store.loadEarlier()
		#expect(h.store.notice == nil)
		// The next load picks up where it left off.
		await h.api.setMessagesError(nil)
		await h.store.loadEarlier()
		#expect(h.store.messages.compactMap(\.serverID) == [2, 3, 4, 5, 6, 7])
	}

	@Test("a real failure loading earlier messages still shows its message")
	func failedEarlierPageIsShown() async {
		let h = ChatHarness(server: (1...7).map { chatMsg($0) }, pageSize: 3)
		await h.store.start()
		await h.api.setMessagesError(wrapped(URLError(.notConnectedToInternet)))
		await h.store.loadEarlier()
		#expect(h.store.notice != nil)
	}

	@Test("a cancelled refresh leaves no sync warning and the next refresh brings the new message")
	func cancelledRefreshIsSilent() async {
		let h = ChatHarness(server: [chatMsg(1, by: "relay", agent: true, "old")])
		await h.store.start()
		await h.api.append(chatMsg(2, by: "relay", agent: true, "new"))
		await h.api.setMessagesError(wrapped(CancellationError()))
		await h.store.refresh()
		#expect(h.store.syncProblem == nil)
		#expect(h.store.notice == nil)
		await h.api.setMessagesError(nil)
		await h.store.refresh()
		#expect(h.store.messages.map(\.serverID) == [1, 2])
	}
}
