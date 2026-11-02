import SwiftUI
import WidgetKit

@main
struct MaskinLiveActivityBundle: WidgetBundle {
	var body: some Widget {
		AgentsLiveActivity()
		CycleLiveActivity()
		MeetingLiveActivity()
		CallLiveActivity()
	}
}
