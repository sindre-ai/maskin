import MaskinCore
import MaskinUI

extension AgentMood {
	init(_ status: AgentStatus) {
		switch status {
		case .running: self = .working
		case .paused: self = .paused
		case .failed: self = .failed
		case .idle: self = .idle
		}
	}

	init(_ state: ChatActor.AgentState) {
		switch state {
		case .running: self = .working
		case .paused: self = .paused
		case .failed: self = .failed
		case .idle, .unknown: self = .idle
		}
	}
}
