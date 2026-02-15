/**
 * LLM Chat Application Template
 *
 * A simple chat application using Cloudflare Workers AI.
 * This template demonstrates how to implement an LLM-powered chat interface with
 * streaming responses using Server-Sent Events (SSE).
 *
 * @license MIT
 */
import { Env, ChatMessage, RealtimeWebhookEvent, RealtimeAgentResponse } from "./types";
import { routeAgentRequest } from "agents";
import { TravelAgent } from "./travel-agent";
import { RealtimeConnector } from "./realtime-connector";

// Export Durable Objects for discovery
export { TravelAgent };
export { RealtimeConnector };

// Model ID for Workers AI model
// https://developers.cloudflare.com/workers-ai/models/
const MODEL_ID = "@cf/meta/llama-3.1-8b-instruct-fp8";

// Default system prompt
const SYSTEM_PROMPT =
	"You are a helpful, friendly assistant. Provide concise and accurate responses.";

export default {
	/**
	 * Main request handler for the Worker
	 */
	async fetch(
		request: Request,
		env: Env,
		ctx: ExecutionContext,
	): Promise<Response> {
		const url = new URL(request.url);

		// Explicit TravelAgent routing - handle before routeAgentRequest
		// This ensures TravelAgent requests are routed correctly
		if (url.pathname.startsWith("/agents/TravelAgent/")) {
			// Extract session name from path: /agents/TravelAgent/{sessionName}/...
			const pathParts = url.pathname.split("/");
			if (pathParts.length >= 4) {
				const sessionName = pathParts[3];
				const agentId = env.TravelAgent.idFromName(sessionName);
				const stub = env.TravelAgent.get(agentId);
				
				// Add PartyServer-required headers
				const headers = new Headers(request.headers);
				headers.set("x-partykit-room", sessionName);
				
				// Clone the request first to get a fresh copy of the body
				// Then create a new request with modified headers
				const clonedRequest = request.clone();
				const body = await clonedRequest.arrayBuffer();
				
				const modifiedRequest = new Request(request.url, {
					method: request.method,
					headers: headers,
					body: body,
				});
				
				return stub.fetch(modifiedRequest);
			}
		}

		// Route other agent requests (if any)
		// routeAgentRequest automatically discovers agents from env bindings
		/**
		 * const agentResponse = await routeAgentRequest(request, env);
		 * if (agentResponse) {
		 * 	return agentResponse;
		 * }
		 */

		// Handle static assets (frontend)
		if (url.pathname === "/" || !url.pathname.startsWith("/api/")) {
			return env.ASSETS.fetch(request);
		}

		// Gateway WebSocket endpoint for low-latency realtime communication
		if (url.pathname === "/api/gateway/ws") {
			return handleGatewayWebSocket(request, env);
		}

		// Realtime webhook endpoint (optional - can use WebSocket instead)
		if (url.pathname === "/api/realtime/webhook") {
			if (request.method === "POST") {
				return handleRealtimeWebhook(request, env);
			}
			return new Response("Method not allowed", { status: 405 });
		}

		// Realtime WebSocket endpoint for server-side connections
		if (url.pathname === "/api/realtime/connect") {
			return handleRealtimeWebSocket(request, env);
		}

		// API Routes
		if (url.pathname === "/api/chat") {
			// Handle POST requests for chat
			if (request.method === "POST") {
				return handleChatRequest(request, env);
			}

			// Method not allowed for other request types
			return new Response("Method not allowed", { status: 405 });
		}

		// Handle 404 for unmatched routes
		return new Response("Not found", { status: 404 });
	},
} satisfies ExportedHandler<Env>;

/**
 * Handles Gateway WebSocket connections for low-latency realtime communication
 * Routes WebSocket connections to the appropriate TravelAgent instance based on userId
 */
async function handleGatewayWebSocket(
	request: Request,
	env: Env,
): Promise<Response> {
	// Check if this is a WebSocket upgrade request
	if (request.headers.get("Upgrade") !== "websocket") {
		return new Response("Expected WebSocket upgrade", { status: 426 });
	}

	const url = new URL(request.url);
	
	// Extract userId from query parameter (e.g., /api/gateway/ws?userId=user123)
	const userId = url.searchParams.get("userId");
	
	if (!userId) {
		return new Response("Missing userId query parameter", { status: 400 });
	}

	try {
		// Get or create TravelAgent instance for this user
		// Each user gets their own agent instance with persistent state
		const agentId = env.TravelAgent.idFromName(userId);
		const stub = env.TravelAgent.get(agentId);

		// Create a new request with PartyServer-required headers
		const headers = new Headers(request.headers);
		headers.set("x-partykit-room", userId);

		// Forward the WebSocket upgrade request to the TravelAgent Durable Object
		// The Durable Object will handle the WebSocket connection and messages
		const modifiedRequest = new Request(request.url, {
			method: request.method,
			headers: headers,
		});

		return await stub.fetch(modifiedRequest);
	} catch (error) {
		console.error("Error handling gateway WebSocket:", error);
		return new Response(
			JSON.stringify({ error: "Failed to establish WebSocket connection" }),
			{
				status: 500,
				headers: { "content-type": "application/json" },
			},
		);
	}
}

/**
 * Handles Realtime webhook events
 * Receives chat events from Realtime and routes them to the TravelAgent
 */
async function handleRealtimeWebhook(
	request: Request,
	env: Env,
): Promise<Response> {
	try {
		// Parse webhook event from Realtime
		const event = (await request.json()) as RealtimeWebhookEvent;

		// Only process message events
		if (event.type !== "message" || !event.message) {
			return new Response(JSON.stringify({ received: true }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}

		// Extract message text and userId
		const messageText = event.message.text || "";
		const userId = event.userId || event.room; // Use room as fallback for userId
		const roomId = event.room;

		if (!messageText.trim()) {
			return new Response(
				JSON.stringify({ error: "Message text is required" }),
				{
					status: 400,
					headers: { "content-type": "application/json" },
				},
			);
		}

		if (!roomId) {
			return new Response(JSON.stringify({ error: "Room ID is required" }), {
				status: 400,
				headers: { "content-type": "application/json" },
			});
		}

		// Get or create TravelAgent instance for this user
		const agentId = env.TravelAgent.idFromName(userId);
		const stub = env.TravelAgent.get(agentId);

		// Call handleMessage on the agent
		// We need to make an RPC call to the agent
		const rpcRequest = {
			type: "rpc",
			id: `realtime-${Date.now()}`,
			method: "handleMessage",
			args: [messageText],
		};

		// Create a request to the agent
		const headers = new Headers();
		headers.set("x-partykit-room", userId);
		headers.set("Content-Type", "application/json");

		const agentRequest = new Request(
			`${request.url.split("/api")[0]}/agents/TravelAgent/${userId}/rpc`,
			{
				method: "POST",
				headers: headers,
				body: JSON.stringify(rpcRequest),
			},
		);

		const agentResponse = await stub.fetch(agentRequest);
		const agentResult = (await agentResponse.json()) as {
			success?: boolean;
			result?: string | { message?: string; [key: string]: unknown };
			error?: string;
		};

		// Extract the response text from the agent result
		let responseText = "";
		if (agentResult.success && agentResult.result) {
			responseText =
				typeof agentResult.result === "string"
					? agentResult.result
					: (agentResult.result.message as string | undefined) ||
						JSON.stringify(agentResult.result);
		} else {
			responseText =
				agentResult.error || "Failed to process message";
		}

		// Publish the agent's response back to Realtime
		await publishToRealtime(env, roomId, responseText, userId);

		return new Response(JSON.stringify({ success: true }), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	} catch (error) {
		console.error("Error handling Realtime webhook:", error);
		return new Response(
			JSON.stringify({
				error: "Failed to process webhook",
				message: error instanceof Error ? error.message : "Unknown error",
			}),
			{
				status: 500,
				headers: { "content-type": "application/json" },
			},
		);
	}
}

/**
 * Handles WebSocket connection to Realtime for server-side connections
 * This allows the Worker to maintain a persistent connection to Realtime
 */
async function handleRealtimeWebSocket(
	request: Request,
	env: Env,
): Promise<Response> {
	// Check if this is a WebSocket upgrade request
	if (request.headers.get("Upgrade") !== "websocket") {
		return new Response("Expected WebSocket upgrade", { status: 426 });
	}

	// RealtimeConnector will be available after running wrangler types
	// Using any for now - will be properly typed after wrangler types
	const realtimeConnector = (env as any).RealtimeConnector;

	if (!realtimeConnector) {
		return new Response("RealtimeConnector not configured", { status: 500 });
	}

	try {
		// Get or create RealtimeConnector instance
		// Use a single instance ID for the connector (or one per namespace)
		const connectorId = realtimeConnector.idFromName("main");
		const stub = realtimeConnector.get(connectorId);

		// Forward the WebSocket upgrade request to the RealtimeConnector
		return await stub.fetch(request);
	} catch (error) {
		console.error("Error handling Realtime WebSocket:", error);
		return new Response(
			JSON.stringify({ error: "Failed to establish Realtime WebSocket connection" }),
			{
				status: 500,
				headers: { "content-type": "application/json" },
			},
		);
	}
}

/**
 * Publishes a message to a Realtime room via WebSocket (optimized for low latency)
 * Uses RealtimeConnector Durable Object to maintain persistent WebSocket connection
 */
async function publishToRealtime(
	env: Env,
	roomId: string,
	text: string,
	userId?: string,
): Promise<void> {
	// Check if Realtime is configured
	if (!env.REALTIME_API_TOKEN || !env.REALTIME_NAMESPACE_ID) {
		console.warn(
			"Realtime not configured: REALTIME_API_TOKEN or REALTIME_NAMESPACE_ID missing",
		);
		return;
	}

	// RealtimeConnector will be available after running wrangler types
	// Using any for now - will be properly typed after wrangler types
	const realtimeConnector = (env as any).RealtimeConnector;

	if (!realtimeConnector) {
		console.warn("RealtimeConnector not available, falling back to HTTP API");
		// Fallback to HTTP API if WebSocket connector not available
		await publishToRealtimeHTTP(env, roomId, text, userId);
		return;
	}

	try {
		const response: RealtimeAgentResponse = {
			type: "agent_response",
			text: text,
			userId: userId,
			timestamp: Date.now(),
		};

		// Use RealtimeConnector Durable Object to publish via WebSocket
		const connectorId = realtimeConnector.idFromName("main");
		const stub = realtimeConnector.get(connectorId);

		// Call the RealtimeConnector's publish endpoint
		// The connector maintains a persistent WebSocket connection to Realtime
		const result = await stub.fetch(
			new Request("https://realtime-connector/publish", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					room: roomId,
					message: response,
				}),
			}),
		);

		if (!result.ok) {
			const errorText = await result.text();
			console.error(`Failed to publish to Realtime via WebSocket: ${errorText}`);
			// Fallback to HTTP
			await publishToRealtimeHTTP(env, roomId, text, userId);
		}
	} catch (error) {
		console.error("Error publishing to Realtime via WebSocket:", error);
		// Fallback to HTTP API
		await publishToRealtimeHTTP(env, roomId, text, userId);
	}
}

/**
 * Fallback: Publishes a message to a Realtime room via HTTP API
 * Used when WebSocket connection is not available
 */
async function publishToRealtimeHTTP(
	env: Env,
	roomId: string,
	text: string,
	userId?: string,
): Promise<void> {
	const response: RealtimeAgentResponse = {
		type: "agent_response",
		text: text,
		userId: userId,
		timestamp: Date.now(),
	};

	const accountId = env.REALTIME_ACCOUNT_ID || env.REALTIME_NAMESPACE_ID;
	const namespaceId = env.REALTIME_NAMESPACE_ID;
	const realtimeUrl = `https://api.cloudflare.com/client/v4/accounts/${accountId}/realtime/namespaces/${namespaceId}/rooms/${roomId}/messages`;

	const publishResponse = await fetch(realtimeUrl, {
		method: "POST",
		headers: {
			"Authorization": `Bearer ${env.REALTIME_API_TOKEN}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify(response),
	});

	if (!publishResponse.ok) {
		const errorText = await publishResponse.text();
		console.error(
			`Failed to publish to Realtime via HTTP: ${publishResponse.status} ${errorText}`,
		);
	}
}

/**
 * Handles chat API requests
 */
async function handleChatRequest(
	request: Request,
	env: Env,
): Promise<Response> {
	try {
		// Parse JSON request body
		const { messages = [] } = (await request.json()) as {
			messages: ChatMessage[];
		};

		// Add system prompt if not present
		if (!messages.some((msg) => msg.role === "system")) {
			messages.unshift({ role: "system", content: SYSTEM_PROMPT });
		}

		const stream = await env.AI.run(
			MODEL_ID,
			{
				messages,
				max_tokens: 1024,
				stream: true,
			},
			{
				// Uncomment to use AI Gateway
				// gateway: {
				//   id: "YOUR_GATEWAY_ID", // Replace with your AI Gateway ID
				//   skipCache: false,      // Set to true to bypass cache
				//   cacheTtl: 3600,        // Cache time-to-live in seconds
				// },
			},
		);

		return new Response(stream, {
			headers: {
				"content-type": "text/event-stream; charset=utf-8",
				"cache-control": "no-cache",
				connection: "keep-alive",
			},
		});
	} catch (error) {
		console.error("Error processing chat request:", error);
		return new Response(
			JSON.stringify({ error: "Failed to process request" }),
			{
				status: 500,
				headers: { "content-type": "application/json" },
			},
		);
	}
}
