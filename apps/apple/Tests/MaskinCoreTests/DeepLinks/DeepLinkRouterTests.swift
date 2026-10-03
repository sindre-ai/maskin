import Foundation
import Testing

@testable import MaskinCore

@MainActor
private final class Harness {
	var signedIn = true
	var current: String? = "ws-1"
	var members: Set<String>? = ["ws-1", "ws-2"]
	var selected: [String] = []
	lazy var router = DeepLinkRouter(
		isSignedIn: { [unowned self] in signedIn },
		currentWorkspaceId: { [unowned self] in current },
		memberWorkspaceIds: { [unowned self] in members },
		selectWorkspace: { [unowned self] id in
			selected.append(id)
			current = id
		})
}

@MainActor
@Suite("DeepLinkRouter")
struct DeepLinkRouterTests {
	@Test("a link into the current workspace is pending at once, with no switch")
	func sameWorkspace() {
		let h = Harness()
		h.router.open(.chat(workspaceId: "ws-1", id: "c1"))
		#expect(h.router.pending == .chat(workspaceId: "ws-1", id: "c1"))
		#expect(h.selected.isEmpty)
	}

	@Test("a link into another member workspace switches first")
	func switches() {
		let h = Harness()
		h.router.open(.object(workspaceId: "ws-2", id: "o1"))
		#expect(h.selected == ["ws-2"])
		#expect(h.router.pending == .object(workspaceId: "ws-2", id: "o1"))
	}

	@Test("a workspace the user isn't in is rejected and never switches")
	func notMember() {
		let h = Harness()
		h.router.open(.object(workspaceId: "ws-evil", id: "o1"))
		#expect(h.router.pending == nil)
		#expect(h.selected.isEmpty)
		#expect(h.router.rejection == .notAMember(workspaceId: "ws-evil"))
	}

	@Test("a link received before workspaces load is held, then resolved")
	func waitsForWorkspaces() {
		let h = Harness()
		h.members = nil
		h.router.open(.chat(workspaceId: "ws-2", id: "c1"))
		#expect(h.router.pending == nil)
		#expect(h.router.incoming != nil)
		h.members = ["ws-1", "ws-2"]
		h.router.evaluate()
		#expect(h.selected == ["ws-2"])
		#expect(h.router.pending == .chat(workspaceId: "ws-2", id: "c1"))
		#expect(h.router.incoming == nil)
	}

	@Test("a link received while signed out is held until sign-in")
	func waitsForSignIn() {
		let h = Harness()
		h.signedIn = false
		h.router.open(.chat(workspaceId: "ws-1", id: "c1"))
		#expect(h.router.pending == nil)
		h.signedIn = true
		h.router.evaluate()
		#expect(h.router.pending == .chat(workspaceId: "ws-1", id: "c1"))
	}

	@Test("consume hands the link over once")
	func consume() {
		let h = Harness()
		h.router.open(.notifications(workspaceId: "ws-1"))
		#expect(h.router.consume() == .notifications(workspaceId: "ws-1"))
		#expect(h.router.consume() == nil)
		#expect(h.router.pending == nil)
	}

	@Test("URLs: a Maskin link is accepted, anything else is unrecognized")
	func urls() {
		let h = Harness()
		#expect(h.router.open(URL(string: "maskin://ws-1/chats/c1")!))
		#expect(h.router.pending != nil)
		_ = h.router.consume()
		#expect(!h.router.open(URL(string: "https://evil.example/ws-1/chats/c1")!))
		#expect(h.router.pending == nil)
		#expect(h.router.rejection == .unrecognized)
	}

	@Test("reset drops held links so they can't fire for the next user")
	func reset() {
		let h = Harness()
		h.signedIn = false
		h.router.open(.chat(workspaceId: "ws-1", id: "c1"))
		h.router.reset()
		h.signedIn = true
		h.router.evaluate()
		#expect(h.router.pending == nil)
	}

	@Test("a new link replaces an older held one")
	func replaces() {
		let h = Harness()
		h.members = nil
		h.router.open(.chat(workspaceId: "ws-1", id: "old"))
		h.router.open(.chat(workspaceId: "ws-1", id: "new"))
		h.members = ["ws-1"]
		h.router.evaluate()
		#expect(h.router.pending == .chat(workspaceId: "ws-1", id: "new"))
	}
}
