import Foundation
import Testing

@testable import MaskinCore

@MainActor
@Suite("Links into other workspaces and to GitHub")
struct LinkedOtherLinksTests {
	let here = "7d1f0c52-0e0a-4f43-9c1e-aaaaaaaaaaaa"
	/// A workspace the reader belongs to.
	let acme = "9b2e1d63-1f1b-4a54-8d2f-bbbbbbbbbbbb"
	/// A workspace the reader is not in.
	let stranger = "c3a4f5e7-2a2c-4b65-9e30-cccccccccccc"
	let id = "11111111-2222-3333-4444-555555555555"
	let fileID = "33333333-2222-3333-4444-555555555555"

	/// A store for `here`, whose switcher list holds only Acme Studio.
	private func store(objects: FakeDraftsRemote = FakeDraftsRemote(), files: FakeLinkedFiles = FakeLinkedFiles())
		-> LinkedItemStore
	{
		let member = acme
		return LinkedItemStore(
			objects: objects, files: files, workspaceID: { "7d1f0c52-0e0a-4f43-9c1e-aaaaaaaaaaaa" },
			workspaceName: { $0.lowercased() == member ? "Acme Studio" : nil })
	}

	private func object(in workspace: String) -> LinkedTarget {
		LinkedTarget.parse(href: "https://maskin.io/\(workspace)/objects/\(id)")!
	}

	// MARK: The address

	@Test("a full address names its workspace; a relative path names none")
	func addressWorkspace() {
		#expect(object(in: here).workspaceID == here)
		#expect(LinkedTarget.parse(href: "maskin://\(acme)/files/\(fileID)")?.workspaceID == acme)
		#expect(LinkedTarget.parse(href: "/\(here)/objects/\(id)")?.workspaceID == nil)
		#expect(LinkedTarget.parse(href: "/objects/\(id)")?.workspaceID == nil)
	}

	@Test("the same thing linked from two workspaces is still one target")
	func identityIgnoresWorkspace() {
		#expect(object(in: here) == object(in: acme))
		#expect(object(in: here) == LinkedTarget(kind: .object, uuid: id))
		#expect(Set([object(in: here), object(in: acme)]).count == 1)
	}

	// MARK: Same workspace

	@Test("a link into the workspace being read is looked up as before")
	func sameWorkspace() async {
		let objects = FakeDraftsRemote()
		let store = store(objects: objects)
		let target = object(in: here)
		#expect(store.state(for: target) == nil)
		#expect(store.showsCard(target))
		await store.resolve([target])
		#expect(objects.detailCalls == [id])
		#expect(store.state(for: target) == .ready(.deleted(target)))
		#expect(store.otherWorkspaceURL(for: target) == nil)
	}

	// MARK: Other member workspace

	@Test("a link into a workspace the reader is in names it, and nothing is fetched")
	func otherMemberWorkspace() async {
		let objects = FakeDraftsRemote()
		let files = FakeLinkedFiles()
		let store = store(objects: objects, files: files)
		let object = object(in: acme)
		let file = LinkedTarget.parse(href: "https://maskin.io/\(acme)/files/\(fileID)")!
		// Known from the address alone, before any lookup.
		#expect(store.isCard(object))
		#expect(store.isCard(file))
		await store.resolve([object, file])
		await store.resolve([object, file])
		#expect(objects.detailCalls.isEmpty)
		#expect(files.calls == 0)

		guard case .otherWorkspace(let link)? = store.item(for: object),
			case .otherWorkspace(let fileLink)? = store.item(for: file)
		else {
			Issue.record("expected the other-workspace card, got \(String(describing: store.state(for: object)))")
			return
		}
		#expect(link.title(workspaceName: store.workspaceName(for: link.workspaceID)) == "Object in Acme Studio")
		#expect(fileLink.title(workspaceName: store.workspaceName(for: fileLink.workspaceID)) == "File in Acme Studio")
		#expect(link.url == DeepLink.object(workspaceId: acme, id: id).url)
		#expect(fileLink.url == DeepLink.file(workspaceId: acme, id: fileID).url)
		#expect(store.otherWorkspaceURL(for: object) == link.url)
	}

	// MARK: Other workspace the reader is not in

	@Test("a link into a workspace the reader is not in says another workspace")
	func otherNonMemberWorkspace() async {
		let objects = FakeDraftsRemote()
		let store = store(objects: objects)
		let target = object(in: stranger)
		await store.resolve([target])
		#expect(objects.detailCalls.isEmpty)
		guard case .otherWorkspace(let link)? = store.item(for: target) else {
			Issue.record("expected the other-workspace card")
			return
		}
		#expect(store.workspaceName(for: stranger) == nil)
		#expect(link.title(workspaceName: store.workspaceName(for: stranger)) == "Object in another workspace")
		#expect(link.title(workspaceName: "  ") == "Object in another workspace")
	}

	@Test("the placeholder counts as a card toward the three in a message")
	func countsTowardTheCap() {
		let store = store()
		let ids = (1...4).map { "0000000\($0)-2222-3333-4444-555555555555" }
		let text = ids.map { "[Link](https://maskin.io/\(stranger)/objects/\($0))" }.joined(separator: "\n\n")
		let parts = LinkedMessageLayout.parts(
			segments: LinkedMessageSplitter.split(text), isCard: { store.isCard($0) },
			limit: LinkedMessageLayout.maxCardsPerMessage)
		let cards = parts.filter { if case .card = $0 { true } else { false } }
		#expect(cards.count == 3)
		// The fourth stays a link in the text.
		#expect(parts.contains { if case .markdown(let text) = $0 { text.contains(ids[3]) } else { false } })
	}

	@Test("the link directory does not look up an object in another workspace")
	func directoryDoesNotLookUp() async {
		let objects = FakeDraftsRemote()
		let store = store(objects: objects)
		let directory = InternalLinkDirectory(store: { store })
		#expect(directory.object(id, workspace: stranger) == nil)
		try? await Task.sleep(for: .milliseconds(50))
		#expect(objects.detailCalls.isEmpty)
	}

	// MARK: GitHub

	private func github(_ address: String) -> GitHubLink? {
		URL(string: address).flatMap { GitHubLink(url: $0) }
	}

	@Test("a pull request address gives the repository and number")
	func pullRequest() {
		let link = github("https://github.com/sindre-ai/maskin/pull/2653")
		#expect(link?.kind == .pullRequest)
		#expect(link?.owner == "sindre-ai")
		#expect(link?.title == "maskin #2653")
		#expect(link?.kindLabel == "Pull request")
		#expect(link?.symbol == "arrow.triangle.pull")
		// A tail on the address is still that pull request.
		#expect(github("https://github.com/sindre-ai/maskin/pull/2653/files")?.title == "maskin #2653")
		#expect(github("https://www.github.com/sindre-ai/maskin/pull/2653#discussion_r1")?.number == 2653)
	}

	@Test("an issue address gives the repository and number")
	func issue() {
		let link = github("https://github.com/sindre-ai/maskin/issues/12")
		#expect(link?.kind == .issue)
		#expect(link?.title == "maskin #12")
		#expect(link?.kindLabel == "Issue")
		#expect(link?.symbol == "smallcircle.filled.circle")
	}

	@Test("anything else is not a GitHub chip")
	func notGitHubChips() {
		for address in [
			"https://github.com/sindre-ai",
			"https://github.com/sindre-ai/maskin",
			"https://github.com/sindre-ai/maskin/commit/9f32943",
			"https://github.com/sindre-ai/maskin/tree/main",
			"https://github.com/sindre-ai/maskin/pull/abc",
			"https://github.com/sindre-ai/maskin/pull/0",
			"https://github.com/sindre-ai/maskin/pull/12345678901",
			"https://github.com/sindre-ai/maskin/pulls",
			"http://github.com/sindre-ai/maskin/pull/1",
			"https://github.com.example.io/sindre-ai/maskin/pull/1",
			"https://gist.github.com/sindre-ai/maskin/pull/1",
			"https://user@github.com/sindre-ai/maskin/pull/1",
			"https://github.com:444/sindre-ai/maskin/pull/1",
			"https://maskin.io/\(here)/objects/\(id)",
		] {
			#expect(github(address) == nil, "\(address)")
		}
	}

	// MARK: Settings

	@Test("a settings page is not a card, a chip or an app route, so it stays a plain link")
	func settings() {
		for address in ["https://maskin.io/\(here)/settings", "https://maskin.io/\(here)/settings/billing"] {
			#expect(LinkedTarget.parse(href: address) == nil, "\(address)")
			#expect(DeepLink(string: address) == nil, "\(address)")
			#expect(github(address) == nil, "\(address)")
		}
	}
}
