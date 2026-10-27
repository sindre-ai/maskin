import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// The saved transcript of a live call, full screen: one row per line with its time, speaker and
/// text. Done returns to the thread.
struct LiveTranscriptView: View {
	let transcript: LiveTranscript
	@Environment(\.dismiss) private var dismiss

	var body: some View {
		NavigationStack {
			ScrollView {
				LazyVStack(alignment: .leading, spacing: 0) {
					if transcript.lines.isEmpty {
						Text(LiveMeetingNote.emptyText).maskinText(.subhead).foregroundStyle(MaskinColor.ink4)
							.padding(MaskinSpace.s9)
					}
					ForEach(transcript.lines) { line in
						LiveTranscriptRow(line: line)
						Divider().overlay(MaskinSurface.separator)
					}
				}
				.padding(.horizontal, MaskinSpace.s9)
				.textSelection(.enabled)
			}
			.background(MaskinSurface.grouped)
			.navigationTitle("Transcript")
			#if os(iOS)
				.navigationBarTitleDisplayMode(.inline)
			#endif
			.toolbar {
				ToolbarItem(placement: .cancellationAction) {
					VStack(alignment: .leading, spacing: 0) {
						Text(transcript.title).maskinText(.caption).foregroundStyle(MaskinColor.ink4)
						if !transcript.subtitle.isEmpty {
							Text(transcript.subtitle).maskinText(.mono).foregroundStyle(MaskinColor.ink4)
						}
					}
				}
				ToolbarItem(placement: .confirmationAction) {
					Button("Done") { dismiss() }
				}
			}
		}
	}
}

private struct LiveTranscriptRow: View {
	let line: LiveTranscriptLine

	var body: some View {
		HStack(alignment: .firstTextBaseline, spacing: MaskinSpace.s7) {
			Text(line.timeLabel).maskinText(.mono).foregroundStyle(MaskinColor.ink5).monospacedDigit()
				.frame(minWidth: MaskinSpace.s14 + MaskinSpace.s12, alignment: .leading)
			VStack(alignment: .leading, spacing: MaskinSpace.s2) {
				Text(line.speaker).maskinText(.caption).fontWeight(.semibold)
					.foregroundStyle(line.isYou ? MaskinColor.sigInk : MaskinColor.ink4)
				Text(line.text).maskinText(.body).foregroundStyle(MaskinColor.ink)
					.fixedSize(horizontal: false, vertical: true)
			}
		}
		.padding(.vertical, MaskinSpace.s7)
		.frame(maxWidth: .infinity, alignment: .leading)
		.accessibilityElement(children: .combine)
		.accessibilityLabel("\(line.timeLabel), \(line.speaker), \(line.text)")
	}
}

#Preview("Transcript, one hour") {
	LiveTranscriptView(transcript: LiveTranscriptPreview.hour)
}

#Preview("Summary card, dark") {
	ScrollView { LiveCallSummaryCard(summary: LiveTranscriptPreview.summary, transcript: LiveTranscriptPreview.hour).padding() }
		.preferredColorScheme(.dark)
}

/// The storyboard's one-hour call, for previews.
private enum LiveTranscriptPreview {
	static let t0 = Date(timeIntervalSince1970: 1_800_000_000)
	static let record = LiveCallRecord(
		id: "preview", conversationID: "c", leadName: "Chief of Staff", startedAt: t0,
		endedAt: t0.addingTimeInterval(3604))
	static func message(_ id: Int, _ you: Bool, _ text: String, at seconds: TimeInterval) -> ChatMessage {
		var m = ChatMessage.confirmed(
			serverID: id, conversationID: "c", actorID: you ? "me" : "cos", actorName: you ? "Sebastian" : "Chief of Staff",
			author: you ? .human : .agent, content: text)
		m.createdAt = t0.addingTimeInterval(seconds)
		return m
	}
	static let hour = LiveTranscript(
		record: record,
		messages: [
			message(1, true, "Make the weekly brief a bet and give the customer note to the Content Writer.", at: 12),
			message(2, false, "I created the bet and assigned the customer note. Anything to add to it?", at: 21),
			message(3, true, "Go on the agent intro bet, Team plan only.", at: 2100),
			message(4, false, "Done. I will recap by email at 15:30.", at: 3604),
		], currentActorID: "me")
	static let summary = LiveCallSummary(
		id: "s", title: "Weekly planning with the Chief of Staff", durationSeconds: 3604, startedAt: t0,
		endedAt: t0.addingTimeInterval(3604),
		decided: ["Lift the PostHog event cap", "Go on the agent intro bet, Team plan only"],
		created: [
			LiveCreatedObject(type: "bet", title: "Weekly brief delivered as audio"),
			LiveCreatedObject(type: "task", title: "Draft customer note on webhook fix"),
		], next: ["Recap by email to you at 15:30"], notDone: ["Update pricing copy, Danish"])
}

extension View {
	/// The transcript opens over the whole screen on iPhone and iPad; other platforms use a sheet.
	func liveTranscriptCover(isPresented: Binding<Bool>, transcript: LiveTranscript?) -> some View {
		#if os(iOS)
			fullScreenCover(isPresented: isPresented) {
				if let transcript { LiveTranscriptView(transcript: transcript) }
			}
		#else
			sheet(isPresented: isPresented) {
				if let transcript { LiveTranscriptView(transcript: transcript) }
			}
		#endif
	}
}
