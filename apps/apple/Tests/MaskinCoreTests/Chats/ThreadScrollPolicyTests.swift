import Testing

@testable import MaskinCore

@Suite("ThreadScrollPolicy")
struct ThreadScrollPolicyTests {
	@Test("while the thread is settling open it jumps, never animates")
	func settlingJumps() {
		#expect(ThreadScrollPolicy.onNewestChanged(followingOpen: true, isAtBottom: false, newestIsMine: false) == .jump)
	}

	@Test("a reader at the bottom, or who just sent, follows")
	func follows() {
		#expect(ThreadScrollPolicy.onNewestChanged(followingOpen: false, isAtBottom: true, newestIsMine: false) == .follow)
		#expect(ThreadScrollPolicy.onNewestChanged(followingOpen: false, isAtBottom: false, newestIsMine: true) == .follow)
	}

	@Test("a reader up in history is left alone and the message is counted")
	func leavesHistoryReader() {
		#expect(ThreadScrollPolicy.onNewestChanged(followingOpen: false, isAtBottom: false, newestIsMine: false) == .countUnseen)
	}
}

@Suite("ThreadRendering")
struct ThreadRenderingTests {
	@Test("short threads are eager, long ones lazy")
	func threshold() {
		#expect(!ThreadRendering.usesLazyStack(rowCount: 0))
		#expect(!ThreadRendering.usesLazyStack(rowCount: ThreadRendering.eagerRowLimit - 1))
		#expect(ThreadRendering.usesLazyStack(rowCount: ThreadRendering.eagerRowLimit))
	}
}
