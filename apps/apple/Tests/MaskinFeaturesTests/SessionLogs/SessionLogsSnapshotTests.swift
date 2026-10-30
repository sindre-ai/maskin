import Foundation
import MaskinCore
import MaskinDesign
import SwiftUI
import Testing
#if canImport(AppKit)
import AppKit
#elseif canImport(UIKit)
import UIKit
#endif

@testable import MaskinFeatures

private struct FixtureLogsAPI: SessionLogsAPI {
	func logs(sessionID: String, query: SessionLogQuery) async throws -> [SessionLogRow] {
		func env(_ json: String) -> String { json }
		let rows: [(String, String)] = [
			("system", "Container started"),
			("stdout", "{\"type\":\"system\",\"subtype\":\"init\"}"),
			(
				"stdout",
				"{\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"Reading the last thread with Priya before drafting.\"}]}}"
			),
			(
				"stdout",
				"{\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"tool_use\",\"name\":\"mcp__maskin__get_conversation\"}]}}"
			),
			("stderr", "warn: slow response from the mail provider (retrying)"),
			(
				"stdout",
				"{\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"Draft is ready and waiting on your approval.\"}]}}"
			),
			("stdout", "{\"type\":\"result\",\"is_error\":false,\"result\":\"Draft saved for review.\"}"),
		]
		return rows.enumerated().map { SessionLogRow(id: $0.offset + 1, stream: $0.element.0, content: $0.element.1) }
	}
}

@MainActor
private func render<V: View>(_ view: V, width: CGFloat, dark: Bool, name: String) throws {
	let framed = view.frame(width: width).background(MaskinSurface.grouped)
		.environment(\.colorScheme, dark ? .dark : .light)
	let renderer = ImageRenderer(content: framed)
	renderer.scale = 2
	guard let image = renderer.cgImage else {
		Issue.record("ImageRenderer produced no image for \(name)")
		return
	}
	let dir =
		ProcessInfo.processInfo.environment["LOGS_SNAPSHOT_DIR"] ?? NSTemporaryDirectory() + "logs-snapshots"
	try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
	let url = URL(fileURLWithPath: dir).appendingPathComponent("\(name)-\(Int(width))-\(dark ? "dark" : "light").png")
	#if canImport(AppKit)
	try NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:])?.write(to: url)
	#elseif canImport(UIKit)
	try UIImage(cgImage: image).pngData()?.write(to: url)
	#endif
}

@Suite("Session logs snapshots")
@MainActor
struct SessionLogsSnapshotTests {
	@Test("readable, raw and problems views render", arguments: [false, true])
	func renders(dark: Bool) async throws {
		let store = SessionLogsStore(sessionID: "s", api: FixtureLogsAPI())
		await store.start(live: false)
		for width in [402.0, 820.0] {
			for filter in SessionLogFilter.allCases {
				store.filter = filter
				let view = VStack(alignment: .leading, spacing: MaskinSpace.s3) {
					SessionLogsLines(store: store)
				}
				.padding(MaskinSpace.s9)
				try render(view, width: width, dark: dark, name: "logs-\(filter.rawValue.lowercased())")
			}
		}
		#expect(store.lines.count == 7)
	}
}
