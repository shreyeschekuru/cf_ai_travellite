/**
 * RealtimeConnector Durable Object
 * 
 * Maintains persistent WebSocket connections to Cloudflare Realtime
 * Handles bidirectional communication: receiving messages and publishing responses
 */

export interface RealtimeConnectorEnv {
	REALTIME_API_TOKEN?: string;
	REALTIME_NAMESPACE_ID?: string;
	REALTIME_ACCOUNT_ID?: string;
}

export class RealtimeConnector {
	private ctx: DurableObjectState;
	private env: RealtimeConnectorEnv;
	private ws: WebSocket | null = null;
	private reconnectAttempts = 0;
	private maxReconnectAttempts = 5;
	private reconnectDelay = 1000; // Start with 1 second
	private rooms = new Set<string>(); // Track subscribed rooms

	constructor(ctx: DurableObjectState, env: RealtimeConnectorEnv) {
		this.ctx = ctx;
		this.env = env;
	}

	/**
	 * Establish WebSocket connection to Realtime
	 */
	async connect(): Promise<void> {
		if (this.ws && this.ws.readyState === WebSocket.READY_STATE_OPEN) {
			return; // Already connected
		}

		if (!this.env.REALTIME_API_TOKEN || !this.env.REALTIME_NAMESPACE_ID) {
			throw new Error("Realtime not configured");
		}

		// Construct Realtime WebSocket URL
		// Format: wss://realtime.cloudflare.com/namespaces/{namespace_id}/rooms/{room_id}
		// For server connections, we may need a different endpoint
		// Note: Authentication may need to be passed via URL query parameter or initial message
		const namespaceId = this.env.REALTIME_NAMESPACE_ID;
		// Include token in URL if Realtime API requires it, or send in initial message
		const wsUrl = `wss://realtime.cloudflare.com/namespaces/${namespaceId}/server?token=${this.env.REALTIME_API_TOKEN}`;

		try {
			// Create WebSocket connection
			// Cloudflare Workers WebSocket constructor only accepts URL and optional protocols
			// Authentication must be handled via URL parameters or initial handshake message
			const ws = new WebSocket(wsUrl);

			ws.addEventListener("open", () => {
				console.log("Realtime WebSocket connected");
				this.reconnectAttempts = 0;
				this.reconnectDelay = 1000;

				// Resubscribe to all previously subscribed rooms
				for (const roomId of this.rooms) {
					this.subscribeToRoom(roomId);
				}
			});

			ws.addEventListener("message", (event) => {
				this.handleRealtimeMessage(event.data);
			});

			ws.addEventListener("error", (error) => {
				console.error("Realtime WebSocket error:", error);
			});

			ws.addEventListener("close", () => {
				console.log("Realtime WebSocket closed");
				this.ws = null;
				this.attemptReconnect();
			});

			this.ws = ws;
		} catch (error) {
			console.error("Failed to connect to Realtime:", error);
			this.attemptReconnect();
		}
	}

	/**
	 * Subscribe to a Realtime room
	 */
	async subscribeToRoom(roomId: string): Promise<void> {
		if (!this.ws || this.ws.readyState !== WebSocket.READY_STATE_OPEN) {
			await this.connect();
		}

		if (this.rooms.has(roomId)) {
			return; // Already subscribed
		}

		try {
			// Send subscription message to Realtime
			const subscribeMessage = {
				type: "subscribe",
				room: roomId,
			};

			if (this.ws && this.ws.readyState === WebSocket.READY_STATE_OPEN) {
				this.ws.send(JSON.stringify(subscribeMessage));
				this.rooms.add(roomId);
				console.log(`Subscribed to Realtime room: ${roomId}`);
			}
		} catch (error) {
			console.error(`Failed to subscribe to room ${roomId}:`, error);
		}
	}

	/**
	 * Publish a message to a Realtime room via WebSocket
	 */
	async publishToRoom(
		roomId: string,
		message: { type: string; text: string; userId?: string; timestamp?: number },
	): Promise<void> {
		if (!this.ws || this.ws.readyState !== WebSocket.READY_STATE_OPEN) {
			await this.connect();
		}

		// Ensure we're subscribed to the room
		await this.subscribeToRoom(roomId);

		try {
			const publishMessage = {
				type: "publish",
				room: roomId,
				message: message,
			};

			if (this.ws && this.ws.readyState === WebSocket.READY_STATE_OPEN) {
				this.ws.send(JSON.stringify(publishMessage));
			} else {
				throw new Error("WebSocket not connected");
			}
		} catch (error) {
			console.error(`Failed to publish to room ${roomId}:`, error);
			throw error;
		}
	}

	/**
	 * Handle incoming messages from Realtime
	 */
	private handleRealtimeMessage(data: string | ArrayBuffer): void {
		try {
			const message = JSON.parse(
				typeof data === "string" ? data : new TextDecoder().decode(data),
			);

			// Handle different message types from Realtime
			if (message.type === "message" && message.room) {
				// Forward to the main Worker for processing
				// This will be handled by the webhook endpoint or a direct handler
				this.ctx.waitUntil(this.processRealtimeMessage(message));
			} else if (message.type === "error") {
				console.error("Realtime error:", message);
			}
		} catch (error) {
			console.error("Error parsing Realtime message:", error);
		}
	}

	/**
	 * Process incoming message from Realtime and route to TravelAgent
	 */
	private async processRealtimeMessage(message: any): Promise<void> {
		// This will be called by the main Worker's webhook handler
		// or we can implement direct routing here
		console.log("Received message from Realtime:", message);
	}

	/**
	 * Attempt to reconnect to Realtime
	 */
	private attemptReconnect(): void {
		if (this.reconnectAttempts >= this.maxReconnectAttempts) {
			console.error("Max reconnection attempts reached");
			return;
		}

		this.reconnectAttempts++;
		const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1); // Exponential backoff

		setTimeout(() => {
			console.log(`Attempting to reconnect to Realtime (attempt ${this.reconnectAttempts})...`);
			this.connect();
		}, delay);
	}

	/**
	 * Handle HTTP requests (for publishing messages, health checks, etc.)
	 */
	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);

		// Handle publish requests
		if (url.pathname === "/publish" && request.method === "POST") {
			try {
				const body = (await request.json()) as {
					room: string;
					message: { type: string; text: string; userId?: string; timestamp?: number };
				};

				await this.publishToRoom(body.room, body.message);
				return Response.json({ success: true });
			} catch (error) {
				return Response.json(
					{ error: error instanceof Error ? error.message : "Unknown error" },
					{ status: 500 },
				);
			}
		}

		// Handle status requests
		if (url.pathname === "/status") {
			return Response.json({
				connected: this.ws?.readyState === WebSocket.READY_STATE_OPEN,
				rooms: Array.from(this.rooms),
			});
		}

		// Handle WebSocket upgrade requests
		if (request.headers.get("Upgrade") === "websocket") {
			// For now, we'll handle WebSocket connections directly
			// This would need to be implemented based on Realtime's WebSocket protocol
			return new Response("WebSocket upgrade not yet implemented", { status: 501 });
		}

		return new Response("Not found", { status: 404 });
	}
}

