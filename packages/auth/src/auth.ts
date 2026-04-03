import { betterAuth } from 'better-auth'

export function createAuth(options: {
	secret: string
	baseURL: string
	database: {
		url: string
	}
}) {
	return betterAuth({
		secret: options.secret,
		baseURL: options.baseURL,
		database: {
			type: 'postgres',
			url: options.database.url,
		},
		emailAndPassword: {
			enabled: true,
		},
	})
}

export type Auth = ReturnType<typeof createAuth>
