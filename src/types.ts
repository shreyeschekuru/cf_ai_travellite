/**
 * Type definitions for the LLM chat application.
 */

export interface Env {

	AI: Ai;
	
	ASSETS: { fetch: (request: Request) => Promise<Response> };

	VECTORIZE: Vectorize;
	KVNAMESPACE: KVNamespace;

	AMADEUS_API_KEY: string;
	AMADEUS_API_SECRET: string;
}

/**
 * Represents a chat message.
 */
export interface ChatMessage {
	role: "system" | "user" | "assistant";
	content: string;
}
