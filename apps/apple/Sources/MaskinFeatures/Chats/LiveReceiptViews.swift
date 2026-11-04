import MaskinCore
import MaskinDesign
import MaskinUI
import Observation
import SwiftUI

/// What the agent did while the call ran: one compact row in the thread, in message order. Tapping a
/// row that made or touched an object opens it.
struct LiveReceiptRow: View {
	let event: LiveReceiptEvent
	@Environment(AppRuntime.self) private var runtime: AppRuntime?

	var body: some View {
		if let objectID = event.objectID {
			Button { runtime?.openObject(objectID) } label: { content(opens: true) }
				.buttonStyle(.maskinPressed)
				.accessibilityHint("Opens it")
		} else {
			content(opens: false)
		}
	}

	private func content(opens: Bool) -> some View {
		HStack(alignment: .top, spacing: MaskinSpace.s7) {
			if !event.timeLabel.isEmpty {
				Text(event.timeLabel).maskinText(.mono).foregroundStyle(MaskinColor.ink5).monospacedDigit()
					.frame(minWidth: MaskinSpace.s12 + MaskinSpace.s7, alignment: .leading)
			}
			VStack(alignment: .leading, spacing: MaskinSpace.s2) {
				HStack(spacing: MaskinSpace.s3) {
					dot
					MonoLabel(event.label, color: labelColor)
				}
				Text(event.text).maskinText(.subhead).foregroundStyle(textColor)
					.fixedSize(horizontal: false, vertical: true)
			}
			Spacer(minLength: MaskinSpace.s3)
			if opens {
				Image(systemName: "chevron.right").maskinSymbol(MaskinFontSize.t12, weight: .semibold)
					.foregroundStyle(MaskinColor.ink5).accessibilityHidden(true)
			}
		}
		.padding(.horizontal, MaskinSpace.s7)
		.padding(.vertical, MaskinSpace.s5)
		.frame(maxWidth: .infinity, minHeight: opens ? MaskinSpace.touchMin : 0, alignment: .leading)
		.background(MaskinSurface.card, in: RoundedRectangle(cornerRadius: MaskinRadius.cardXl, style: .continuous))
		.overlay(
			RoundedRectangle(cornerRadius: MaskinRadius.cardXl, style: .continuous)
				.strokeBorder(MaskinSurface.line, lineWidth: 1))
		.contentShape(Rectangle())
		.accessibilityElement(children: .ignore)
		.accessibilityLabel(
			[event.timeLabel, event.label.capitalized, event.text].filter { !$0.isEmpty }.joined(separator: ", "))
	}

	@ViewBuilder private var dot: some View {
		if event.outcome.didRun {
			Circle().fill(dotColor).frame(width: MaskinSpace.s4, height: MaskinSpace.s4)
		} else {
			// A change that did not happen has no filled dot.
			Circle().strokeBorder(MaskinColor.ink5, lineWidth: 1.5).frame(width: MaskinSpace.s4, height: MaskinSpace.s4)
		}
	}

	private var dotColor: Color {
		event.kind.objectType.map(MaskinObjectType.dotColor(for:)) ?? MaskinColor.patina500
	}

	private var labelColor: Color {
		switch event.outcome {
		case .ran: MaskinColor.ink4
		case .failed: MaskinColor.dangerStrong
		case .notDone: MaskinColor.ink4
		}
	}

	private var textColor: Color { event.outcome.didRun ? MaskinColor.ink : MaskinColor.ink3 }
}

/// The card that closes a call: what was decided, made and left for later, and a button that opens
/// the call's transcript full screen.
struct LiveCallSummaryCard: View {
	let summary: LiveCallSummary
	/// What "Read transcript" opens; nil when the call is not on this device.
	let transcript: LiveTranscript?
	@Environment(AppRuntime.self) private var runtime: AppRuntime?
	@State private var showsTranscript = false

	var body: some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s9) {
			header
			VStack(alignment: .leading, spacing: MaskinSpace.s3) {
				Text(summary.title.isEmpty ? "Live meeting" : summary.title)
					.maskinText(.headline).foregroundStyle(MaskinColor.ink)
					.fixedSize(horizontal: false, vertical: true)
				if let when = Self.whenText(start: summary.startedAt, end: summary.endedAt) {
					Text(when).maskinText(.subhead).foregroundStyle(MaskinColor.ink4)
				}
			}
			if let closing = summary.closing {
				Text(closing).maskinText(.subhead).foregroundStyle(MaskinColor.ink2).lineLimit(4)
			}
			checks("Decided", summary.decided)
			created
			checks("Next", summary.next)
			notDone
			if transcript != nil {
				Button {
					showsTranscript = true
					MaskinHaptics.play(.light)
				} label: {
					Text("Read transcript")
				}
				.buttonStyle(.primaryAction)
			}
		}
		.padding(MaskinSpace.s9)
		.frame(maxWidth: .infinity, alignment: .leading)
		.background(MaskinSurface.card, in: RoundedRectangle(cornerRadius: MaskinRadius.tile, style: .continuous))
		.overlay(
			RoundedRectangle(cornerRadius: MaskinRadius.tile, style: .continuous)
				.strokeBorder(MaskinSurface.line, lineWidth: 1))
		.accessibilityElement(children: .contain)
		.liveTranscriptCover(isPresented: $showsTranscript, transcript: transcript)
	}

	private var header: some View {
		HStack {
			Text("LIVE MEETING").maskinText(.microLabel).foregroundStyle(MaskinColor.stLab)
				.padding(.horizontal, MaskinSpace.s4).padding(.vertical, MaskinSpace.s2)
				.background(MaskinColor.sigTint, in: Capsule())
			Spacer()
			if !summary.durationLabel.isEmpty {
				Text(summary.durationLabel).maskinText(.mono).foregroundStyle(MaskinColor.ink3).monospacedDigit()
			}
		}
	}

	@ViewBuilder private func checks(_ title: String, _ items: [String]) -> some View {
		if !items.isEmpty {
			VStack(alignment: .leading, spacing: MaskinSpace.s4) {
				MonoLabel("\(title) · \(items.count)")
				ForEach(Array(items.enumerated()), id: \.offset) { _, item in
					HStack(alignment: .firstTextBaseline, spacing: MaskinSpace.s4) {
						Image(systemName: "checkmark").maskinSymbol(MaskinFontSize.t12, weight: .bold)
							.foregroundStyle(MaskinColor.patina500).accessibilityHidden(true)
						Text(item).maskinText(.subhead).foregroundStyle(MaskinColor.ink)
							.fixedSize(horizontal: false, vertical: true)
					}
				}
			}
			.accessibilityElement(children: .combine)
		}
	}

	@ViewBuilder private var created: some View {
		if !summary.created.isEmpty {
			VStack(alignment: .leading, spacing: MaskinSpace.s4) {
				MonoLabel("Created · \(summary.created.count)")
				FlowLayout(spacing: MaskinSpace.s4) {
					ForEach(Array(summary.created.enumerated()), id: \.offset) { _, object in chip(object) }
				}
			}
		}
	}

	@ViewBuilder private func chip(_ object: LiveCreatedObject) -> some View {
		let label = HStack(spacing: MaskinSpace.s3) {
			Circle().fill(MaskinObjectType.dotColor(for: object.type)).frame(width: MaskinSpace.s4, height: MaskinSpace.s4)
			Text(object.title).maskinText(.caption).foregroundStyle(MaskinColor.ink2).lineLimit(1)
		}
		.padding(.horizontal, MaskinSpace.s5)
		.frame(minHeight: MaskinSpace.touchMin)
		.background(MaskinSurface.fillStrong, in: Capsule())
		if let id = object.objectID {
			Button { runtime?.openObject(id) } label: { label }
				.buttonStyle(.maskinPressed).accessibilityLabel("Open \(object.title)")
		} else {
			label
		}
	}

	/// Plain text, never a button: it records what was not done, there is nothing to tap.
	@ViewBuilder private var notDone: some View {
		if !summary.notDone.isEmpty {
			VStack(alignment: .leading, spacing: MaskinSpace.s4) {
				MonoLabel("Not done · \(summary.notDone.count)")
				ForEach(Array(summary.notDone.enumerated()), id: \.offset) { _, item in
					Text(item).maskinText(.subhead).foregroundStyle(MaskinColor.ink3)
						.fixedSize(horizontal: false, vertical: true)
				}
			}
			.accessibilityElement(children: .combine)
		}
	}

	/// "Tue 14:02 to 15:02"; just the start when the end is unknown.
	static func whenText(start: Date?, end: Date?) -> String? {
		guard let start else { return nil }
		let day = start.formatted(.dateTime.weekday(.abbreviated))
		let from = start.formatted(.dateTime.hour().minute())
		guard let end else { return "\(day) \(from)" }
		return "\(day) \(from) to \(end.formatted(.dateTime.hour().minute()))"
	}
}
