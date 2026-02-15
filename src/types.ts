/**
 * Type definitions for the LLM chat application.
 */
import { TravelAgent } from "./travel-agent";

export interface Env extends Cloudflare.Env {
	//AI and ASSETS are inherited from Cloudflare.Env
	VECTORIZE: Vectorize;
	KVNAMESPACE: KVNamespace;

	AMADEUS_API_KEY: string;
	AMADEUS_API_SECRET: string;

	// Travel Agent Durable Object binding
	TRAVEL_AGENT: DurableObjectNamespace<TravelAgent>;
}

/**
 * Represents a chat message.
 */
export interface ChatMessage {
	role: "system" | "user" | "assistant";
	content: string;
}
