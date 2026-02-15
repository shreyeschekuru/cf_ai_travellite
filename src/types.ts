/**
 * Type definitions for the LLM chat application.
 */

export interface Env extends Cloudflare.Env {
	//AI, ASSETS, TravelAgent, and VECTORIZE are inherited from Cloudflare.Env
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
