import Foundation
import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI
import Testing
#if canImport(AppKit)
import AppKit
#endif

@testable import MaskinCore
@testable import MaskinFeatures

/// A flat 4:5 "slide" in a colour, so the strip has something to draw without the network.
private func slide(_ hue: Double) -> DecodedImage {
	let width = 216, height = 270
	let space = CGColorSpaceCreateDeviceRGB()
	let context = CGContext(
		data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0, space: space,
		bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
	context.setFillColor(CGColor(red: hue, green: 0.35, blue: 1 - hue, alpha: 1))
	context.fill(CGRect(x: 0, y: 0, width: width, height: height))
	return DecodedImage(context.makeImage()!)
}

@MainActor
@Suite("Draft media strip renders")
struct PreviewMediaSnapshotTests {
	private func render<V: View>(_ view: V, width: CGFloat, dark: Bool, name: String, largest: Bool = false) async throws {
		#if canImport(AppKit)
		let framed = view
			.padding(MaskinSpace.s9)
			.frame(width: width)
			.background(MaskinSurface.grouped)
			.environment(\.colorScheme, dark ? .dark : .light)
			.environment(\.dynamicTypeSize, largest ? .accessibility5 : .large)
		let host = NSHostingView(rootView: framed)
		host.appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
		let window = NSWindow(
			contentRect: NSRect(x: 0, y: 0, width: width, height: 800), styleMask: [.borderless], backing: .buffered,
			defer: false)
		window.contentView = host
		for _ in 0..<15 {
			host.frame.size = NSSize(width: width, height: max(host.fittingSize.height, 10))
			host.layoutSubtreeIfNeeded()
			try? await Task.sleep(for: .milliseconds(100))
		}
		window.setContentSize(host.frame.size)
		guard let rep = host.bitmapImageRepForCachingDisplay(in: host.bounds) else {
			Issue.record("no bitmap for \(name)")
			return
		}
		host.cacheDisplay(in: host.bounds, to: rep)
		let dir =
			ProcessInfo.processInfo.environment["CHATS_SNAPSHOT_DIR"] ?? NSTemporaryDirectory() + "chats-snapshots"
		try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
		let url = URL(fileURLWithPath: dir).appendingPathComponent(
			"\(name)-\(Int(width))-\(dark ? "dark" : "light")\(largest ? "-largest" : "").png")
		try rep.representation(using: .png, properties: [:])?.write(to: url)
		#endif
	}

	private func item(_ id: String, _ name: String, _ mime: String, size: Int = 90_000) -> PreviewMediaItem {
		PreviewMediaItem(file: FileReference(id: id, name: name, mimeType: mime, sizeBytes: size))
	}

	@Test("a seven slide carousel, one picture, and a mixed strip, at phone and tablet widths")
	func strips() async throws {
		let images = AttachmentImages(
			cached: { id in slide(Double(abs(id.hashValue % 10)) / 10) },
			load: { id in slide(Double(abs(id.hashValue % 10)) / 10) })
		let carousel = (1...7).map { item("s\($0)", "slide-\($0).png", "image/png") }
		let mixed = [
			item("m1", "cover.png", "image/png"), item("m2", "teaser.mp4", "video/mp4", size: 8_000_000),
			item("m3", "deck.pdf", "application/pdf", size: 1_064_264),
		]
		for dark in [false, true] {
			for width in [375.0, 768.0] {
				let content = VStack(alignment: .leading, spacing: MaskinSpace.s7) {
					PreviewMediaStrip(ids: carousel.map(\.id), preloaded: carousel)
					PreviewMediaStrip(ids: ["s1"], preloaded: [carousel[0]])
					PreviewMediaStrip(ids: mixed.map(\.id), preloaded: mixed)
				}
				.environment(\.attachmentImages, images)
				try await render(content, width: width, dark: dark, name: "preview-media")
			}
		}
		let content = PreviewMediaStrip(ids: carousel.map(\.id), preloaded: carousel)
			.environment(\.attachmentImages, images)
		try await render(content, width: 375, dark: false, name: "preview-media", largest: true)
	}

	@Test("a draft with no readable media draws nothing")
	func empty() async throws {
		try await render(
			PreviewMediaStrip(ids: ["gone"], preloaded: []), width: 375, dark: false, name: "preview-media-empty")
	}
}
