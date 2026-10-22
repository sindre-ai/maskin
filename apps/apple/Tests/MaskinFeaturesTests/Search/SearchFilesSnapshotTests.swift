import CoreGraphics
import Foundation
import ImageIO
import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI
import Testing
import UniformTypeIdentifiers

@testable import MaskinFeatures

private struct StubSearch: SearchRemote {
	var fail = false
	func searchObjects(query: String, limit: Int) async throws -> [SearchResult] {
		if fail { throw SearchError("You're offline.", isOffline: true) }
		return [
			SearchResult(
				kind: .object, entityId: "o1", title: "Launch checklist for the iOS app",
				subtitle: "in progress", snippet: "Before we launch we need push notifications, TestFlight and a privacy review.",
				detail: "task", updatedAt: Date(timeIntervalSinceNow: -3600)),
			SearchResult(kind: .object, entityId: "o2", title: "Launch retro", subtitle: "done", detail: "insight"),
		]
	}
	func searchFiles(query: String, limit: Int) async throws -> [SearchResult] {
		if fail { throw SearchError("You're offline.", isOffline: true) }
		return [SearchResult(kind: .file, entityId: "f1", title: "launch-plan.md", subtitle: "Markdown", snippet: "The plan for launch week", detail: "text/markdown")]
	}
	func conversations() async throws -> [SearchResult] {
		if fail { throw SearchError("You're offline.", isOffline: true) }
		return [SearchResult(kind: .chat, entityId: "c1", title: "Launch coordination", subtitle: "Sigrid Larsen, Forge", snippet: "Who owns the launch email?")]
	}
	func agents() async throws -> [SearchResult] {
		if fail { throw SearchError("You're offline.", isOffline: true) }
		return [SearchResult(kind: .agent, entityId: "a1", title: "Launch Captain", snippet: "Coordinates launches")]
	}
}

private struct StubFiles: FilesRemote {
	var file: FileDetail
	func file(id: String) async throws -> FileDetail { file }
}

private let markdownFile = FileDetail(
	id: "f1", name: "launch-plan.md", description: "Week-by-week launch plan", mimeType: "text/markdown",
	sizeBytes: 1_240, updatedAt: Date(timeIntervalSinceNow: -7200),
	data: Data("""
		# Launch plan

		We ship **Thursday**. The checklist:

		- TestFlight build approved
		- Privacy review signed off
		- `FF_TESTER_FEATURES` cleared

		> Keep the changelog short.
		""".utf8),
	annotations: [
		FileAnnotation(id: "p1", pinNumber: 1, comment: "Can we move this to Wednesday?"),
		FileAnnotation(id: "p2", pinNumber: 2, comment: "Needs legal sign-off first."),
	])

private func outputDirectory() -> URL {
	let path = ProcessInfo.processInfo.environment["SEARCH_SNAPSHOT_DIR"] ?? NSTemporaryDirectory()
	let url = URL(fileURLWithPath: path, isDirectory: true)
	try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
	return url
}

@MainActor
private func snapshot<V: View>(
	_ name: String, width: CGFloat, dark: Bool, @ViewBuilder _ content: () -> V
) throws {
	let view = content()
		.frame(width: width, height: 900)
		.background(MaskinSurface.grouped)
		.environment(\.colorScheme, dark ? .dark : .light)
	let renderer = ImageRenderer(content: view)
	renderer.scale = 2
	let image = try #require(renderer.cgImage)
	let url = outputDirectory().appendingPathComponent("\(name)-\(Int(width))-\(dark ? "dark" : "light").png")
	let dest = try #require(CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil))
	CGImageDestinationAddImage(dest, image, nil)
	#expect(CGImageDestinationFinalize(dest))
}

private let sizes: [(CGFloat, Bool)] = [(402, false), (402, true), (820, false), (820, true)]

@MainActor
private func store(_ remote: StubSearch = StubSearch(), query: String? = nil) async -> SearchStore {
	let defaults = UserDefaults(suiteName: "snap-\(UUID().uuidString)")!
	let recents = SearchRecents(defaults: defaults)
	recents.push("launch", workspaceId: "w")
	recents.push("push notifications", workspaceId: "w")
	let store = SearchStore(remote: remote, recents: recents, workspaceId: { "w" }, debounce: .milliseconds(1))
	if let query {
		store.setQuery(query)
		await store.settle()
	}
	return store
}

@MainActor
@Suite("Search and Files snapshots")
struct SearchFilesSnapshotTests {
	@Test("recents state")
	func recents() async throws {
		let s = await store()
		for (w, d) in sizes { try snapshot("search-recents", width: w, dark: d) { SearchContentBody(store: s, onSelect: { _ in }).padding(MaskinSpace.s9) } }
	}

	@Test("grouped results with highlights")
	func results() async throws {
		let s = await store(query: "launch")
		#expect(s.sections.count == 4)
		for (w, d) in sizes { try snapshot("search-results", width: w, dark: d) { SearchContentBody(store: s, onSelect: { _ in }).padding(MaskinSpace.s9) } }
	}

	@Test("no matches")
	func noMatches() async throws {
		let s = await store(query: "zzzz-no-match")
		#expect(s.sections.isEmpty || s.visibleCount > 0)
		for (w, d) in sizes { try snapshot("search-empty", width: w, dark: d) { SearchContentBody(store: s, onSelect: { _ in }).padding(MaskinSpace.s9) } }
	}

	@Test("total failure")
	func failure() async throws {
		let s = await store(StubSearch(fail: true), query: "launch")
		#expect(s.phase == .failed("You're offline."))
		for (w, d) in sizes { try snapshot("search-error", width: w, dark: d) { SearchContentBody(store: s, onSelect: { _ in }).padding(MaskinSpace.s9) } }
	}

	@Test("markdown file with review comments")
	func markdown() async throws {
		let s = FileStore(fileId: "f1", remote: StubFiles(file: markdownFile), preload: markdownFile)
		for (w, d) in sizes { try snapshot("file-markdown", width: w, dark: d) { FileScreenBody(store: s, scrolls: false) } }
	}

	@Test("unknown type shows metadata and a share hint; failure and loading states render")
	func otherStates() async throws {
		var other = markdownFile
		other.name = "archive.zip"
		other.mimeType = "application/zip"
		other.annotations = []
		let s = FileStore(fileId: "f1", remote: StubFiles(file: other), preload: other)
		let missing = FileStore(fileId: "x", remote: StubFiles(file: other))
		for (w, d) in sizes {
			try snapshot("file-other", width: w, dark: d) { FileScreenBody(store: s, scrolls: false) }
			try snapshot("file-loading", width: w, dark: d) { FileScreenBody(store: missing, scrolls: false) }
		}
	}
}
