import { describe, expect, it } from 'vitest'
import { directChatTitleForViewer } from '../../services/direct-chat'

const ada = { actorId: 'a', actorName: 'Ada', actorType: 'human' }
const bo = { actorId: 'b', actorName: 'Bo', actorType: 'human' }
const helper = { actorId: 'h', actorName: 'Helper', actorType: 'agent' }

describe('directChatTitleForViewer', () => {
	it('names a direct message between two people after the other person', () => {
		const chat = { title: 'Bo', directPairKey: 'a:b' }
		expect(directChatTitleForViewer(chat, [ada, bo], 'a')).toBe('Bo')
		expect(directChatTitleForViewer(chat, [ada, bo], 'b')).toBe('Ada')
	})

	it('keeps the stored title of a direct message with an agent', () => {
		const chat = { title: 'Helper', directPairKey: 'a:h' }
		expect(directChatTitleForViewer(chat, [ada, helper], 'a')).toBe('Helper')
	})

	it('keeps the stored title of a chat that is not a direct message', () => {
		const chat = { title: 'Q3 plan', directPairKey: null }
		expect(directChatTitleForViewer(chat, [ada, bo], 'a')).toBe('Q3 plan')
	})
})
