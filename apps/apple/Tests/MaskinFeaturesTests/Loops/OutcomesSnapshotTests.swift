import Foundation
import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI
import Testing
#if canImport(AppKit)
import AppKit
#elseif canImport(UIKit)
import UIKit
#endif

@testable import MaskinFeatures

private let base = Date()

private let outcomes: [Outcome] = [
	Outcome(
		fileID: "f1", name: "Weekly pipeline brief", kind: .html, loopID: "l1", loopName: "Market watch",
		updatedAt: base.addingTimeInterval(-1800)),
	Outcome(
		fileID: "f2", name: "Competitor moves, week 40", kind: .markdown, loopID: "l1",
		loopName: "Market watch", sourceTitle: "Initech renewal at risk",
		updatedAt: base.addingTimeInterval(-86400)),
	Outcome(
		fileID: "f3", name: "Q3 build report with a long title that has to wrap onto two lines", kind: .pdf,
		loopID: "l2", loopName: "Dev ROI", updatedAt: base.addingTimeInterval(-86400 * 9)),
]

@MainActor
private func render<V: View>(_ view: V, width: CGFloat, dark: Bool, name: String) throws {
	let framed = view
		.frame(width: width)
		.background(MaskinSurface.grouped)
		.environment(\.colorScheme, dark ? .dark : .light)
	let renderer = ImageRenderer(content: framed)
	renderer.scale = 2
	guard let image = renderer.cgImage else {
		Issue.record("ImageRenderer produced no image for \(name)")
		return
	}
	let dir =
		ProcessInfo.processInfo.environment["OUTCOMES_SNAPSHOT_DIR"]
		?? NSTemporaryDirectory() + "outcomes-snapshots"
	try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
	let url = URL(fileURLWithPath: dir).appendingPathComponent("\(name)-\(Int(width))-\(dark ? "dark" : "light").png")
	#if canImport(AppKit)
	try NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:])?.write(to: url)
	#elseif canImport(UIKit)
	try UIImage(cgImage: image).pngData()?.write(to: url)
	#endif
}

/// `ImageRenderer` can't draw a `WKWebView`, so the page preview is covered by the sandbox unit
/// tests and by running the app; these cover the rows and the labels around it.
@Suite("Outcomes snapshots")
@MainActor
struct OutcomesSnapshotTests {
	static let widths: [CGFloat] = [402, 820]

	@Test("outcome rows render for every kind", arguments: [false, true])
	func rows(dark: Bool) throws {
		for width in Self.widths {
			let view = VStack(alignment: .leading, spacing: MaskinSpace.s5) {
				ForEach(outcomes) { OutcomeRow(outcome: $0) }
			}
			.padding(MaskinSpace.s9)
			try render(view, width: width, dark: dark, name: "outcome-rows")
		}
	}

	@Test("every kind has a human label")
	func labels() {
		let kinds: [FileContentKind] = [.html, .markdown, .pdf, .image, .text, .source, .other]
		for kind in kinds { #expect(!OutcomeLabels.kind(kind).isEmpty) }
		#expect(OutcomeLabels.kind(.html) == "Page")
	}

	@Test("an output from the loop graph becomes an outcome with the loop's name")
	func fromOutput() {
		let loop = LoopSummary(id: "l1", name: "Market watch", status: .supervised)
		let outcome = Outcome(output: LoopOutput(id: "f1", name: "brief.html", sourceTitle: "Acme"), loop: loop)
		#expect(outcome.loopName == "Market watch")
		#expect(outcome.isHTML)
		#expect(outcome.sourceTitle == "Acme")
	}
}
