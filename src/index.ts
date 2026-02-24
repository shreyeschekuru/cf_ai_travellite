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
import { TravelAgent } from "./travel-agent";
import { RealtimeConnector } from "./realtime-connector";
import { runPipeline, parseSSEChunk } from "./pipeline";

// Export Durable Objects for discovery
export { TravelAgent };
export { RealtimeConnector };

// Model ID for Workers AI model
// https://developers.cloudflare.com/workers-ai/models/
const MODEL_ID = "@cf/meta/llama-3.1-8b-instruct-fp8";

// Default system prompt
const SYSTEM_PROMPT =
	"You are a helpful, friendly assistant. Provide concise and accurate responses.";

/**
 * Helper function to route TravelAgent requests to the Durable Object
 * This is the working pattern that routes correctly
 */
async function routeTravelAgentRequest(
	request: Request,
	env: Env,
): Promise<Response | null> {
	const url = new URL(request.url);
	console.log("[routeTravelAgentRequest] Checking path:", url.pathname);

	if (url.pathname.startsWith("/agents/TravelAgent/")) {
		console.log("[routeTravelAgentRequest] TravelAgent path detected");
		// Extract session name from path: /agents/TravelAgent/{sessionName}/...
		const pathParts = url.pathname.split("/");
		if (pathParts.length >= 4) {
			const sessionName = pathParts[3];
			console.log("[routeTravelAgentRequest] Session name:", sessionName);
			const agentId = env.TravelAgent.idFromName(sessionName);
			const stub = env.TravelAgent.get(agentId);
			console.log("[routeTravelAgentRequest] Stub ID:", stub.id.toString());
			
			// Add PartyServer-required headers
			const headers = new Headers(request.headers);
			headers.set("x-partykit-room", sessionName);
			
			// Only read and include body for methods that support it (POST, PUT, PATCH)
			const methodsWithBody = ["POST", "PUT", "PATCH"];
			const hasBody = methodsWithBody.includes(request.method);
			let body: ArrayBuffer | null = null;
			if (hasBody) {
				try {
					const clonedRequest = request.clone();
					body = await clonedRequest.arrayBuffer();
					console.log("[routeTravelAgentRequest] Body read successfully, length:", body.byteLength);
				} catch (error) {
					console.error("[routeTravelAgentRequest] Error reading body:", error);
					body = null;
				}
			}

			// Construct a valid URL with dummy base (DO stub requires absolute URL)
			const doPath = url.pathname + (url.search || "");
			const doUrl = new URL(doPath, "https://dummy").toString();
			const modifiedRequest = new Request(doUrl, {
				method: request.method,
				headers: headers,
				body: body,
			});
			
			console.log("[routeTravelAgentRequest] Calling stub.fetch()...");
			console.log("[routeTravelAgentRequest] DO Request URL:", modifiedRequest.url);
			console.log("[routeTravelAgentRequest] Request method:", modifiedRequest.method);
			const response = await stub.fetch(modifiedRequest);
			console.log("[routeTravelAgentRequest] stub.fetch() completed, status:", response.status);
			return response;
		}
	}
	console.log("[routeTravelAgentRequest] Not a TravelAgent path, returning null");
	return null;
}

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

		// Serve Travel Agent chat frontend at /agents/TravelAgent (no session in path)
		if (request.method === "GET" && (url.pathname === "/agents/TravelAgent" || url.pathname === "/agents/TravelAgent/")) {
			return env.ASSETS.fetch(new Request(new URL("/agents-travel-agent.html", url.origin), { method: "GET" }));
		}

		// Stream endpoint: run travel-agent pipeline (RAG + tools + LLM) and return SSE stream
		if (url.pathname === "/api/agents/TravelAgent/stream" && request.method === "POST") {
			return handleTravelAgentStream(request, env);
		}

		// Send message into the single-door flow (same as webhook: triggers TravelAgent DO → Realtime)
		// POST body: { roomId, userId?, text }. Used when the UI cannot send via Realtime client (e.g. testing).
		if (url.pathname === "/api/realtime/send" && request.method === "POST") {
			return handleRealtimeSend(request, env);
		}

		// Realtime participant token for browser client (join room, send/listen via Realtime)
		if (url.pathname === "/api/realtime/token" && request.method === "GET") {
			return handleRealtimeToken(request, env);
		}

		// Route TravelAgent RPC and HTTP to the Durable Object
		if (url.pathname.startsWith("/agents/TravelAgent/")) {
			const agentResponse = await routeTravelAgentRequest(request, env);
			if (agentResponse) {
				return agentResponse;
			}
		}

		// Handle static assets (frontend)
		if (url.pathname === "/" || !url.pathname.startsWith("/api/")) {
			return env.ASSETS.fetch(request);
		}

		// Realtime webhook endpoint
		if (url.pathname === "/api/realtime/webhook") {
			if (request.method === "POST") {
				return handleRealtimeWebhook(request, env, ctx);
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

		// RAG seeding endpoint
		if (url.pathname === "/api/seed-rag") {
			if (request.method === "POST") {
				return handleSeedRAG(request, env);
			}
			return new Response("Method not allowed", { status: 405 });
		}

		// Test endpoint for LLM, RAG, and tool calling
		if (url.pathname === "/api/test/llm-rag-tools") {
			if (request.method === "POST") {
				return handleTestLLMRAGTools(request, env);
			}
			return new Response("Method not allowed", { status: 405 });
		}

		// Handle 404 for unmatched routes
		return new Response("Not found", { status: 404 });
	},
} satisfies ExportedHandler<Env>;

/**
 * Handle streaming chat using the travel-agent pipeline (RAG + tools + LLM).
 * POST body: { message: string }. Returns Workers AI SSE stream.
 */
async function handleTravelAgentStream(request: Request, env: Env): Promise<Response> {
	try {
		const body = (await request.json()) as { message?: string };
		const message = typeof body?.message === "string" ? body.message.trim() : "";
		if (!message) {
			return new Response(JSON.stringify({ error: "message is required" }), {
				status: 400,
				headers: { "content-type": "application/json" },
			});
		}
		const stream = await runPipeline(env, message, {});
		return new Response(stream, {
			headers: {
				"content-type": "text/event-stream; charset=utf-8",
				"cache-control": "no-cache",
				connection: "keep-alive",
			},
		});
	} catch (error) {
		console.error("[TravelAgent stream] Error:", error);
		return new Response(
			JSON.stringify({ error: "Failed to run pipeline", message: error instanceof Error ? error.message : "Unknown error" }),
			{ status: 500, headers: { "content-type": "application/json" } },
		);
	}
}

/**
 * POST /api/realtime/send — inject a message into the single-door flow.
 * Same path as webhook: Gateway Worker → TravelAgent DO → Realtime.
 * Body: { roomId: string, userId?: string, text: string }.
 */
async function handleRealtimeSend(request: Request, env: Env): Promise<Response> {
	try {
		const body = (await request.json()) as { roomId?: string; userId?: string; text?: string };
		const roomId = body.roomId;
		const text = body.text ?? "";
		const userId = body.userId ?? roomId ?? "web";
		if (!roomId || typeof roomId !== "string") {
			return Response.json({ error: "roomId is required" }, { status: 400 });
		}
		if (!text.trim()) {
			return Response.json({ error: "text is required" }, { status: 400 });
		}
		const rpcRequest = {
			type: "rpc",
			id: `send-${Date.now()}`,
			method: "handleMessageStreaming",
			args: [text.trim(), roomId, userId],
		};
		const agentPath = `/agents/TravelAgent/${userId}/rpc`;
		const agentUrl = new URL(agentPath, request.url);
		const agentRequest = new Request(agentUrl.toString(), {
			method: "POST",
			headers: { "Content-Type": "application/json", "x-partykit-room": userId },
			body: JSON.stringify(rpcRequest),
		});
		const res = await routeTravelAgentRequest(agentRequest, env);
		if (!res) {
			return Response.json({ error: "Failed to route to TravelAgent" }, { status: 500 });
		}
		if (!res.ok) {
			const err = await res.text();
			return Response.json({ error: "TravelAgent error", details: err }, { status: 502 });
		}
		const data = (await res.json()) as { result?: { success?: boolean; message?: string } };
		return Response.json({ success: true, message: data.result?.message ?? "Processing started" });
	} catch (e) {
		console.error("[RealtimeSend] Error:", e);
		return Response.json(
			{ error: "Send failed", message: e instanceof Error ? e.message : "Unknown error" },
			{ status: 500 },
		);
	}
}

/**
 * GET /api/realtime/token — return Realtime participant auth token and meeting/room id for the frontend.
 * Requires REALTIME_ACCOUNT_ID, REALTIME_APP_ID, CLOUDFLARE_API_TOKEN.
 */
async function handleRealtimeToken(request: Request, env: Env): Promise<Response> {
	const accountId = env.REALTIME_ACCOUNT_ID;
	const appId = env.REALTIME_APP_ID;
	const token = env.REALTIME_API_TOKEN || env.CLOUDFLARE_API_TOKEN;
	if (!accountId || !appId || !token) {
		return Response.json(
			{ error: "Realtime token not configured", need: ["REALTIME_ACCOUNT_ID", "REALTIME_APP_ID", "CLOUDFLARE_API_TOKEN"] },
			{ status: 503 },
		);
	}
	try {
		const createUrl = `https://api.cloudflare.com/client/v4/accounts/${accountId}/realtime/kit/${appId}/meetings`;
		const createRes = await fetch(createUrl, {
			method: "POST",
			headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
			body: JSON.stringify({ title: "Travel Agent " + Date.now() }),
		});
		if (!createRes.ok) {
			const t = await createRes.text();
			console.error("[RealtimeToken] Create meeting failed:", createRes.status, t);
			return Response.json({ error: "Failed to create meeting", details: t }, { status: 502 });
		}
		const createData = (await createRes.json()) as { result?: { id?: string }; success?: boolean };
		const meetingId = createData.result?.id;
		if (!meetingId) {
			return Response.json({ error: "No meeting id in response" }, { status: 502 });
		}
		const partUrl = `https://api.cloudflare.com/client/v4/accounts/${accountId}/realtime/kit/${appId}/meetings/${meetingId}/participants`;
		const partRes = await fetch(partUrl, {
			method: "POST",
			headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
			body: JSON.stringify({
				name: "User",
				preset_name: "default",
				custom_participant_id: "web-" + Date.now(),
			}),
		});
		if (!partRes.ok) {
			const t = await partRes.text();
			console.error("[RealtimeToken] Add participant failed:", partRes.status, t);
			return Response.json({ error: "Failed to add participant", details: t }, { status: 502 });
		}
		const partData = (await partRes.json()) as { result?: { auth_token?: string }; success?: boolean };
		const authToken = partData.result?.auth_token;
		if (!authToken) {
			return Response.json({ error: "No auth_token in response" }, { status: 502 });
		}
		return Response.json({ meetingId, roomId: meetingId, authToken });
	} catch (e) {
		console.error("[RealtimeToken] Error:", e);
		return Response.json(
			{ error: "Token failed", message: e instanceof Error ? e.message : "Unknown error" },
			{ status: 500 },
		);
	}
}

/**
 * Handle RAG file seeding
 */
async function handleSeedRAG(request: Request, env: Env): Promise<Response> {
	try {
		const { fileName, content } = await request.json() as { fileName: string; content: string };

		if (!fileName || !content) {
			return Response.json(
				{ success: false, error: "fileName and content are required" },
				{ status: 400 }
			);
		}

		// Check if already ingested
		const kvKey = `rag:file:${fileName}`;
		const existing = await env.KVNAMESPACE.get(kvKey);
		
		if (existing) {
			return Response.json({
				success: true,
				skipped: true,
				message: "File already ingested",
			});
		}

		// Generate embedding
		const embeddingResponse = await env.AI.run("@cf/baai/bge-base-en-v1.5", {
			text: [content],
		});

		// Extract embedding
		let embedding: number[] = [];
		if (embeddingResponse && typeof embeddingResponse === "object" && "data" in embeddingResponse) {
			const data = embeddingResponse.data as any;
			if (Array.isArray(data) && data.length > 0) {
				if (Array.isArray(data[0])) {
					embedding = data[0];
				} else {
					embedding = data;
				}
			}
		}

		if (embedding.length === 0) {
			return Response.json(
				{ success: false, error: "Failed to generate embedding" },
				{ status: 500 }
			);
		}

		// Extract topic from filename
		const topic = fileName.replace(".txt", "").replace(/_/g, " ");

		// Prepare metadata
		const metadata = {
			source: "base-rag-file",
			type: "travel-knowledge",
			topic: topic,
			fileName: fileName,
			text: content, // Store full content for retrieval
			createdAt: Date.now(),
		};

		// Create ID from filename
		const id = `rag-${fileName.replace(".txt", "").replace(/[^a-z0-9]/gi, "-").toLowerCase()}`;

		// Upsert to Vectorize
		await env.VECTORIZE.upsert([
			{
				id: id,
				values: embedding,
				metadata: metadata,
			},
		]);

		// Mark as ingested in KV
		await env.KVNAMESPACE.put(kvKey, JSON.stringify({
			ingestedAt: Date.now(),
			fileName: fileName,
		}));

		return Response.json({
			success: true,
			id: id,
			message: "File ingested successfully",
		});
	} catch (error) {
		console.error("Error seeding RAG file:", error);
		return Response.json(
			{
				success: false,
				error: error instanceof Error ? error.message : "Unknown error",
			},
			{ status: 500 }
		);
	}
}

/**
 * Test endpoint to verify LLM, RAG, and tool calling work
 */
async function handleTestLLMRAGTools(
	request: Request,
	env: Env,
): Promise<Response> {
	try {
		const body = (await request.json()) as { message?: string };
		const message = body.message || "Hello, I want to plan a trip to Paris";
		
		console.log("[Test] Starting LLM/RAG/Tools test with message:", message);
		
		// Create RPC request to call testLLMRAGTools (lightweight test method)
		const rpcRequest = {
			type: "rpc",
			id: `test-${Date.now()}`,
			method: "testLLMRAGTools",
			args: [message],
		};
		
		const agentPath = `/agents/TravelAgent/test-session/rpc`;
		const agentUrl = new URL(agentPath, request.url);
		
		const headers = new Headers();
		headers.set("x-partykit-room", "test-session");
		headers.set("Content-Type", "application/json");
		
		const agentRequest = new Request(agentUrl.toString(), {
			method: "POST",
			headers: headers,
			body: JSON.stringify(rpcRequest),
		});
		
		console.log("[Test] Calling TravelAgent.testLLMRAGTools via routeTravelAgentRequest...");
		console.log("[Test] Agent request URL:", agentRequest.url);
		
		// Use routeTravelAgentRequest instead of stub.fetch() directly
		// This ensures proper routing and body handling
		const response = await routeTravelAgentRequest(agentRequest, env);
		
		if (!response) {
			return new Response(
				JSON.stringify({ error: "Failed to route to TravelAgent" }),
				{ status: 500, headers: { "content-type": "application/json" } },
			);
		}
		
		if (!response.ok) {
			const errorText = await response.text();
			return new Response(
				JSON.stringify({ error: "RPC call failed", details: errorText }),
				{ status: 500, headers: { "content-type": "application/json" } },
			);
		}
		
		const result = (await response.json()) as { 
			result?: {
				success: boolean;
				ragTriggered: boolean;
				toolsTriggered: boolean;
				ragContextLength: number;
				toolResultsLength: number;
				llmStarted: boolean;
				preview: string;
			};
			[key: string]: unknown;
		};
		console.log("[Test] RPC result received");
		
		// testLLMRAGTools returns metadata, not the full stream
		const testResult = result.result;
		
		return new Response(
			JSON.stringify({
				success: true,
				message: "Test completed",
				testResults: testResult,
			}),
			{
				status: 200,
				headers: { "content-type": "application/json" },
			},
		);
	} catch (error) {
		console.error("[Test] Error:", error);
		return new Response(
			JSON.stringify({
				error: "Test failed",
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
 * Handles Realtime webhook events
 * Receives chat events from Realtime and routes them to the TravelAgent
 */
async function handleRealtimeWebhook(
	request: Request,
	env: Env,
	ctx: ExecutionContext,
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

		// Single door: route to TravelAgent DO. DO runs RAG + tools + LLM and streams via RealtimeConnector.
		const userIdFromEvent = event.userId ?? event.room ?? "anonymous";
		const rpcRequest = {
			type: "rpc",
			id: `realtime-${Date.now()}`,
			method: "handleMessageStreaming",
			args: [messageText.trim(), roomId, userIdFromEvent],
		};
		const agentPath = `/agents/TravelAgent/${userIdFromEvent}/rpc`;
		const agentUrl = new URL(agentPath, request.url);
		const agentRequest = new Request(agentUrl.toString(), {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"x-partykit-room": userId,
			},
			body: JSON.stringify(rpcRequest),
		});
		console.log("[Webhook] Routing to TravelAgent DO handleMessageStreaming, room=%s userId=%s", roomId, userId);
		routeTravelAgentRequest(agentRequest, env)
			.then((res) => {
				if (res && !res.ok) res.text().then((t) => console.error("[Webhook] TravelAgent RPC error:", res?.status, t));
			})
			.catch((e) => {
				console.error("[Webhook] TravelAgent RPC failed:", e);
				publishToRealtime(env, roomId, `Error: ${e instanceof Error ? e.message : "Request failed"}`, userId).catch(() => {});
			});

		return new Response(JSON.stringify({ success: true, message: "Processing started" }), {
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
 * Publish a single chunk or control message to Realtime (streaming start/chunk/complete).
 * Used by Worker pipeline to forward LLM stream chunks via RealtimeConnector DO only.
 */
async function publishChunkToRealtime(
	env: Env,
	roomId: string,
	text: string,
	userId: string | undefined,
	flags?: { streaming?: boolean; chunk?: boolean; complete?: boolean },
): Promise<void> {
	const realtimeConnector = (env as any).RealtimeConnector;
	if (!realtimeConnector) return;
	const connectorId = realtimeConnector.idFromName("main");
	const stub = realtimeConnector.get(connectorId);
	const message: Record<string, unknown> = {
		type: "agent_response",
		text,
		userId,
		timestamp: Date.now(),
	};
	if (flags?.streaming) message.streaming = true;
	if (flags?.chunk) message.chunk = true;
	if (flags?.complete) message.complete = true;
	await stub.fetch(
		new Request("https://realtime-connector/publish", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ room: roomId, message }),
		}),
	);
}

/**
 * Read LLM stream (SSE), parse chunks, and publish each to Realtime via RealtimeConnector DO.
 * Runs in the Worker; DO only forwards/publishes.
 */
async function streamPipelineToRealtime(
	env: Env,
	stream: ReadableStream<Uint8Array>,
	roomId: string,
	userId: string | undefined,
): Promise<void> {
	await publishChunkToRealtime(env, roomId, "", userId, { streaming: true });
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	const maxChunks = 500;
	const deadline = Date.now() + 60_000;
	let chunkCount = 0;
	try {
		while (chunkCount < maxChunks && Date.now() < deadline) {
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			const { contents, buffer: nextBuffer } = parseSSEChunk(buffer);
			buffer = nextBuffer;
			for (const content of contents) {
				if (content && content.trim().length > 0) {
					chunkCount++;
					await publishChunkToRealtime(env, roomId, content, userId, { chunk: true });
				}
			}
		}
		if (chunkCount >= maxChunks || Date.now() >= deadline) {
			await publishChunkToRealtime(env, roomId, " [Response truncated.]", userId, { chunk: true });
		}
	} finally {
		reader.releaseLock();
	}
	await publishChunkToRealtime(env, roomId, "", userId, { complete: true });
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
	// Check if Realtime is configured (with fallbacks)
	const namespaceId = env.REALTIME_NAMESPACE_ID || env.REALTIME_APP_ID;
	const apiToken = env.REALTIME_API_TOKEN || env.CLOUDFLARE_API_TOKEN;
	
	if (!apiToken || !namespaceId) {
		console.warn(
			"Realtime not configured: Missing REALTIME_API_TOKEN (or CLOUDFLARE_API_TOKEN) and REALTIME_NAMESPACE_ID (or REALTIME_APP_ID)",
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

	const accountId = env.REALTIME_ACCOUNT_ID || env.REALTIME_NAMESPACE_ID || env.REALTIME_APP_ID;
	const namespaceId = env.REALTIME_NAMESPACE_ID || env.REALTIME_APP_ID;
	const apiToken = env.REALTIME_API_TOKEN || env.CLOUDFLARE_API_TOKEN;
	
	if (!apiToken || !namespaceId) {
		console.error("Cannot publish to Realtime: Missing credentials");
		return;
	}
	
	const realtimeUrl = `https://api.cloudflare.com/client/v4/accounts/${accountId}/realtime/namespaces/${namespaceId}/rooms/${roomId}/messages`;

	const publishResponse = await fetch(realtimeUrl, {
		method: "POST",
		headers: {
			"Authorization": `Bearer ${apiToken}`,
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
