import Foundation
import MaskinCore
import Testing

@testable import MaskinFeatures

@Suite("TV briefing logic")
struct TVBriefingLogicTests {
	@Test func aLeadingFigureBecomesTheBigNumeral() {
		let found = TVSlideClassifier.stat(in: "7 follow-ups are ready to send.")
		#expect(found?.big == "7")
		#expect(found?.rest == "follow-ups are ready to send.")
		#expect(TVSlideClassifier.stat(in: "18% more replies than last week")?.big == "18%")
	}

	@Test func textWithoutALeadingFigureIsNotAStat() {
		#expect(TVSlideClassifier.stat(in: "Northwind needs a call today.") == nil)
		#expect(TVSlideClassifier.stat(in: "Replies are up 18% this week.") == nil)
	}

	@Test func aYearOrABareNumberIsNotAHeadlineFigure() {
		#expect(TVSlideClassifier.stat(in: "2026 planning starts Monday.") == nil)
		#expect(TVSlideClassifier.stat(in: "42") == nil)
	}

	@Test func theLastSlideIsTheCallToAction() {
		let kinds = TVSlideClassifier.kinds(for: ["7 drafts are done.", "Hold the rest.", "Review Northwind."])
		#expect(kinds == [.stat(big: "7", rest: "drafts are done."), .text, .cta])
	}

	@Test func aSingleSlideIsTheCallToAction() {
		#expect(TVSlideClassifier.kinds(for: ["3 things wait on you."]) == [.cta])
		#expect(TVSlideClassifier.kinds(for: []).isEmpty)
	}

	@Test func longerTextGetsSmallerType() {
		let short = TVSlideClassifier.textSize(for: "Short.")
		let long = TVSlideClassifier.textSize(for: String(repeating: "word ", count: 50))
		#expect(short == 72)
		#expect(long < short)
	}

	@Test func flowsSubtitleCountsFlowsAndWhatNeedsYou() {
		func flow(_ id: String, waiting: Int) -> LoopSummary {
			LoopSummary(id: id, name: id, status: .supervised, waitingCount: waiting)
		}
		#expect(TVFlowsHeader.subtitle(for: []) == nil)
		#expect(TVFlowsHeader.subtitle(for: [flow("a", waiting: 0)]) == "1 flow \u{00B7} nothing needs you")
		#expect(TVFlowsHeader.subtitle(for: [flow("a", waiting: 1), flow("b", waiting: 0)]) == "2 flows \u{00B7} 1 needs you")
		#expect(TVFlowsHeader.subtitle(for: [flow("a", waiting: 2), flow("b", waiting: 1)]) == "2 flows \u{00B7} 2 need you")
	}
}
