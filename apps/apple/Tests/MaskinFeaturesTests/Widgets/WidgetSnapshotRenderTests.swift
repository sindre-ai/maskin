import CoreGraphics
import Foundation
import ImageIO
import MaskinCore
import MaskinDesign
import SwiftUI
import Testing
import UniformTypeIdentifiers
import WidgetKit

// The widget views live in Apps/MaskinWidgets/Views (the extension target). `Views` here is a
// symlink to that folder so the same files compile into this test target and render on the host.

private let now = Date(timeIntervalSince1970: 1_800_000_000)

private enum Scenario: String, CaseIterable {
	case decisions, one, many, empty, emptyUnread, stale, signedOut, unavailable

	var state: WidgetState {
		switch self {
		case .decisions: .content(.sample(now: now))
		case .one:
			.content(
				WidgetSnapshot(
					actorId: "a", workspaceId: "w", needsCount: 1,
					decisions: [WidgetSnapshot.sample(now: now).decisions[0]], unreadCount: 0, updatedAt: now))
		case .many:
			.content(
				WidgetSnapshot(
					actorId: "a", workspaceId: "w", needsCount: 12,
					decisions: WidgetSnapshot.sample(now: now).decisions, unreadCount: 100, updatedAt: now))
		case .empty: .content(.sampleEmpty(now: now))
		case .emptyUnread:
			.content(
				WidgetSnapshot(
					actorId: "a", workspaceId: "w", needsCount: 0, decisions: [], unreadCount: 7, updatedAt: now))
		case .stale:
			.content(
				{
					var s = WidgetSnapshot.sample(now: now)
					s.updatedAt = now.addingTimeInterval(-47 * 60)
					return s
				}())
		case .signedOut: .signedOut
		case .unavailable: .unavailable
		}
	}
}

@MainActor
private func png<V: View>(_ view: V, size: CGSize, dark: Bool, name: String) throws {
	let framed = view
		.frame(width: size.width, height: size.height)
		.environment(\.colorScheme, dark ? .dark : .light)
	let renderer = ImageRenderer(content: framed)
	renderer.scale = 3
	guard let image = renderer.cgImage else { throw CocoaError(.fileWriteUnknown) }
	let dir = URL(
		fileURLWithPath: ProcessInfo.processInfo.environment["WIDGET_SNAPSHOT_DIR"]
			?? NSTemporaryDirectory())
	try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
	let url = dir.appendingPathComponent("\(name)-\(dark ? "dark" : "light").png")
	let dest = try #require(CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil))
	CGImageDestinationAddImage(dest, image, nil)
	#expect(CGImageDestinationFinalize(dest))
}

/// A stand-in for the system's widget chrome: card background, 22pt corners, 16pt margins.
private struct HomeFrame: View {
	let size: HomeSize
	let state: WidgetState
	var body: some View {
		NeedsYouHomeView(entry: MaskinWidgetEntry(date: now, state: state), size: size)
			.padding(16)
			.background(MaskinSurface.card)
			.clipShape(RoundedRectangle(cornerRadius: 22, style: .continuous))
			.overlay(RoundedRectangle(cornerRadius: 22, style: .continuous).strokeBorder(MaskinSurface.line))
			.padding(8)
			.background(MaskinSurface.grouped)
	}
}

/// Lock-screen widgets are drawn vibrant white over the wallpaper.
private struct LockFrame: View {
	let kind: LockKind
	let state: WidgetState
	var body: some View {
		LockScreenView(entry: MaskinWidgetEntry(date: now, state: state), kind: kind)
			.foregroundStyle(.white)
			.padding(kind == .inline ? 0 : 8)
			.background(
				kind == .circular
					? AnyShapeStyle(Color.white.opacity(0.18)) : AnyShapeStyle(Color.white.opacity(0.0)),
				in: kind == .circular
					? AnyShape(Circle()) : AnyShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
			)
			.padding(10)
			.background(
				LinearGradient(colors: [Color(red: 0.2, green: 0.25, blue: 0.5), Color(red: 0.05, green: 0.05, blue: 0.15)], startPoint: .top, endPoint: .bottom))
	}
}

@MainActor
@Suite("Widget renders")
struct WidgetSnapshotRenderTests {
	private let home: [(HomeSize, String, CGSize)] = [
		(.small, "small", CGSize(width: 186, height: 186)),
		(.medium, "medium", CGSize(width: 380, height: 186)),
		(.large, "large", CGSize(width: 380, height: 398)),
	]
	private let lock: [(LockKind, String, CGSize)] = [
		(.circular, "circular", CGSize(width: 96, height: 96)),
		(.rectangular, "rectangular", CGSize(width: 192, height: 96)),
		(.inline, "inline", CGSize(width: 260, height: 40)),
	]

	@Test("renders every home-screen family for every state, light and dark")
	func homeFamilies() throws {
		for scenario in Scenario.allCases {
			for (family, name, size) in home {
				for dark in [false, true] {
					try png(
						HomeFrame(size: family, state: scenario.state), size: size, dark: dark,
						name: "home-\(name)-\(scenario.rawValue)")
				}
			}
		}
	}

	@Test("renders every lock-screen family for every state")
	func lockFamilies() throws {
		for scenario in Scenario.allCases {
			for (family, name, size) in lock {
				try png(
					LockFrame(kind: family, state: scenario.state), size: size, dark: true,
					name: "lock-\(name)-\(scenario.rawValue)")
			}
		}
	}

	@Test("the gallery sample uses invented content only")
	func sampleIsInvented() {
		let sample = WidgetSnapshot.sample(now: now)
		#expect(sample.workspaceId == "preview" && sample.actorId == "preview")
		#expect(sample.needsCount == sample.decisions.count)
	}
}
