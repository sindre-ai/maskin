import CoreGraphics
import Foundation
import ImageIO
import MaskinCore
import MaskinDesign
import SwiftUI
import Testing
import UniformTypeIdentifiers

private struct SnapRemote: ShareRemote {
	var failCreate: ShareError?
	var hang = false
	func workspace() async throws -> ShareWorkspace {
		ShareWorkspace(id: "ws-1", name: "Mesh Firm", schema: .fallback)
	}
	func createObject(type: String, title: String, content: String, status: String, idempotencyKey: String) async throws -> String {
		if hang { try await Task.sleep(for: .seconds(60)) }
		if let failCreate { throw failCreate }
		return "obj-1"
	}
	func uploadFile(name: String, mimeType: String, fileURL: URL, idempotencyKey: String) async throws -> String { "f" }
	func attach(fileID: String, toObject objectID: String, objectType: String, idempotencyKey: String) async throws {}
}

@MainActor
private func write<V: View>(_ view: V, name: String, dark: Bool) throws {
	let framed = view.frame(width: 402, height: 780).environment(\.colorScheme, dark ? .dark : .light)
	let renderer = ImageRenderer(content: framed)
	renderer.scale = 2
	guard let image = renderer.cgImage else { throw CocoaError(.fileWriteUnknown) }
	let dir = URL(fileURLWithPath: ProcessInfo.processInfo.environment["SHARE_SNAPSHOT_DIR"] ?? NSTemporaryDirectory())
	try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
	let url = dir.appendingPathComponent("share-\(name)-\(dark ? "dark" : "light").png")
	let dest = try #require(CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil))
	CGImageDestinationAddImage(dest, image, nil)
	#expect(CGImageDestinationFinalize(dest))
}

@MainActor
private func model(_ content: ShareContent, remote: SnapRemote = SnapRemote(), signedIn: Bool = true, workspace: String? = "ws-1") -> ShareSheetModel {
	let store = InMemorySecretStore(
		signedIn ? try! JSONEncoder().encode(StoredSession(apiKey: "ank_x", actorId: "a", name: "S", workspaceId: workspace)) : nil)
	return ShareSheetModel(secretStore: store, loadContent: { content }, makeRemote: { _ in remote })
}

@MainActor
@Suite("Share snapshots")
struct ShareSnapshotTests {
	@Test("renders every sheet state, light and dark")
	func render() async throws {
		let tmp = FileManager.default.temporaryDirectory.appendingPathComponent("snap-\(UUID().uuidString)")
		try FileManager.default.createDirectory(at: tmp, withIntermediateDirectories: true)
		let pic = tmp.appendingPathComponent("photo.jpg")
		let ctx = CGContext(data: nil, width: 400, height: 300, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
		ctx.setFillColor(CGColor(red: 0.3, green: 0.5, blue: 0.9, alpha: 1)); ctx.fill(CGRect(x: 0, y: 0, width: 400, height: 300))
		ctx.setFillColor(CGColor(red: 1, green: 0.8, blue: 0.2, alpha: 1)); ctx.fillEllipse(in: CGRect(x: 100, y: 80, width: 160, height: 160))
		let sink = CGImageDestinationCreateWithURL(pic as CFURL, UTType.jpeg.identifier as CFString, 1, nil)!
		CGImageDestinationAddImage(sink, ctx.makeImage()!, nil); CGImageDestinationFinalize(sink)

		let link = ShareContent(link: URL(string: "https://www.nrk.no/norge/some-long-article-slug")!, linkTitle: "Retail chains are dropping self-serve onboarding")
		let text = ShareContent(text: "\u{201C}Nobody on my side could tell what step 3 wanted from us.\u{201D}\n\nIda Bergstrom, Nordic Retail AS")
		let image = ShareContent(attachments: [ShareAttachment(kind: .image, name: "IMG_2041.jpg", mimeType: "image/jpeg", fileURL: pic, sizeBytes: 1_480_000)])
		let pdf = ShareContent(attachments: [ShareAttachment(kind: .pdf, name: "Q3 retention brief.pdf", mimeType: "application/pdf", fileURL: pic, sizeBytes: 3_200_000)], skipped: [ShareSkip(name: "recording.mov", reason: .tooLarge)])

		for dark in [false, true] {
			for (name, content) in [("link", link), ("text", text), ("image", image), ("pdf", pdf)] {
				let m = model(content); await m.start(); m.note = name == "link" ? "Competitor is moving the same way" : ""
				try write(ShareSheetView(model: m, onClose: {}, onOpen: { _ in }), name: name, dark: dark)
			}
			let typing = model(link); await typing.start(); typing.destination = .object(type: "task")
			try write(ShareSheetView(model: typing, onClose: {}, onOpen: { _ in }), name: "task-selected", dark: dark)

			let posting = model(pdf, remote: SnapRemote(hang: true)); await posting.start()
			let t = Task { await posting.post() }
			try await Task.sleep(for: .milliseconds(100))
			try write(ShareSheetView(model: posting, onClose: {}, onOpen: { _ in }), name: "posting", dark: dark)
			t.cancel()

			let failed = model(link, remote: SnapRemote(failCreate: .offline)); await failed.start(); await failed.post()
			try write(ShareSheetView(model: failed, onClose: {}, onOpen: { _ in }), name: "failed", dark: dark)

			let done = model(link); await done.start(); await done.post()
			try write(ShareSheetView(model: done, onClose: {}, onOpen: { _ in }), name: "posted", dark: dark)

			let out = model(link, signedIn: false); await out.start()
			try write(ShareSheetView(model: out, onClose: {}, onOpen: { _ in }), name: "signedout", dark: dark)
			let nows = model(link, workspace: nil); await nows.start()
			try write(ShareSheetView(model: nows, onClose: {}, onOpen: { _ in }), name: "noworkspace", dark: dark)
		}
	}
}
