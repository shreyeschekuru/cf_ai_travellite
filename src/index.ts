/**
 * LLM Chat Application Template
 *
 * A simple chat application using Cloudflare Workers AI.
 * This template demonstrates how to implement an LLM-powered chat interface with
 * streaming responses using Server-Sent Events (SSE).
 *
 * @license MIT
 */
import { Env, ChatMessage } from "./types";
import { routeAgentRequest } from "agents";
import { TravelAgent } from "./travel-agent";

// Export TravelAgent for Durable Objects and agent discovery
export { TravelAgent };

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
