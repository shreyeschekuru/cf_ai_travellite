/**
 * Type definitions for the LLM chat application.
 */

export interface Env extends Cloudflare.Env {
	//AI, ASSETS, TravelAgent, KVNAMESPACE and VECTORIZE are inherited from Cloudflare.Env

	AMADEUS_API_KEY: string;
	AMADEUS_API_SECRET: string;
	
	// Realtime configuration
	REALTIME_API_TOKEN?: string;
	REALTIME_NAMESPACE_ID?: string;
}

/**
 * Represents a chat message.
 */
export interface ChatMessage {
	role: "system" | "user" | "assistant";
	content: string;
}

/**
 * WebSocket message format for Gateway communication
 * Sent from client to agent
 */
export interface GatewayMessage {
	type: "message";
	text: string;
	userId?: string;
	timestamp?: number;
}

/**
 * WebSocket response format from Gateway
 * Sent from agent to client
 */
export interface GatewayResponse {
	type: "response";
	text?: string;
	userId?: string;
	error?: string;
	timestamp?: number;
}

/**
 * Internal protocol messages from the agents framework
 * These are sent automatically by PartyServer/agents framework
 */
export interface AgentProtocolMessage {
	type: 
		| "cf_agent_identity"
		| "cf_agent_state"
		| "cf_agent_mcp_servers"
		| "cf_agent_error";
	[key: string]: unknown;
}

/**
 * Union type for all possible WebSocket messages received from the server
 */
export type WebSocketServerMessage = GatewayResponse | AgentProtocolMessage;

/**
 * Union type for all possible WebSocket messages sent to the server
 */
export type WebSocketClientMessage = GatewayMessage;

/**
 * Type guard to check if a message is a GatewayMessage
 */
export function isGatewayMessage(message: unknown): message is GatewayMessage {
	return (
		typeof message === "object" &&
		message !== null &&
		"type" in message &&
		message.type === "message" &&
		"text" in message &&
		typeof message.text === "string"
	);
}

/**
 * Type guard to check if a message is a GatewayResponse
 */
export function isGatewayResponse(message: unknown): message is GatewayResponse {
	return (
		typeof message === "object" &&
		message !== null &&
		"type" in message &&
		message.type === "response" &&
		("text" in message || "error" in message)
	);
}

/**
 * Type guard to check if a message is an AgentProtocolMessage
 */
export function isAgentProtocolMessage(
	message: unknown,
): message is AgentProtocolMessage {
	return (
		typeof message === "object" &&
		message !== null &&
		"type" in message &&
		typeof message.type === "string" &&
		message.type.startsWith("cf_agent_")
	);
}

/**
 * Parsed message data from WebSocket
 * Can be a GatewayMessage or a plain string
 */
export type ParsedWebSocketMessage = GatewayMessage | string;

/**
 * Realtime webhook event format
 * Sent from Cloudflare Realtime when a message is received
 */
export interface RealtimeWebhookEvent {
	type: "message" | "presence" | "connection";
	room: string;
	userId?: string;
	message?: {
		text: string;
		[key: string]: unknown;
	};
	timestamp?: number;
	[key: string]: unknown;
}

/**
 * Realtime agent response format
 * Published back to Realtime rooms
 */
export interface RealtimeAgentResponse {
	type: "agent_response";
	text: string;
	userId?: string;
	timestamp?: number;
}
