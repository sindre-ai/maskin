import Testing

@testable import MaskinCore

@Suite("Live call audio route") struct LiveAudioRouteTests {
	@Test func theSpeakerIsForcedBackWhenTheSoundHasFallenToTheEarpiece() {
		#expect(LiveAudioRoute.needsSpeakerOverride(wantsSpeaker: true, output: .receiver))
	}

	@Test func nothingIsForcedWhenTheSpeakerIsAlreadyPlaying() {
		#expect(!LiveAudioRoute.needsSpeakerOverride(wantsSpeaker: true, output: .speaker))
	}

	@Test func headphonesAndBluetoothWinOverTheSpeaker() {
		#expect(!LiveAudioRoute.needsSpeakerOverride(wantsSpeaker: true, output: .other))
	}

	@Test func theEarpieceStaysWhenThePersonChoseIt() {
		#expect(!LiveAudioRoute.needsSpeakerOverride(wantsSpeaker: false, output: .receiver))
	}

	@Test func nothingIsForcedBeforeThereIsARoute() {
		#expect(!LiveAudioRoute.needsSpeakerOverride(wantsSpeaker: true, output: nil))
	}
}
