import { Agent, callable } from "agents";
import { Env } from "./types";
import { AmadeusClient } from "./amadeus-client";
import { runPipeline, classifyConversation, type PipelineTripState } from "./pipeline";

/**
 * Basic trip information
 */
export type TripBasics = {
	/** Departure city or airport code (e.g. NYC, Dallas) for flights */
	origin?: string;
	destination?: string;
	startDate?: string;
	endDate?: string;
	budget?: number;
};

/**
 * State interface for the Travel Agent
 */
export interface TravelState {
	/**
	 * Basic trip information (destination, dates, budget)
	 */
	basics: TripBasics;

	/**
	 * User preferences (e.g., "nightlife", "coffee", "walkable", "beach", "museums")
	 */
	preferences: string[];

	/**
	 * Current itinerary (e.g., array of days with activities)
	 */
	currentItinerary: any;

	/**
	 * Recent conversation messages
	 */
	recentMessages: Array<{
		role: "user" | "assistant";
		content: string;
	}>;

	/**
	 * Current conversation intent (State Object). All subsequent messages are treated as part of this flow until a global intent or explicit change.
	 */
	currentIntent?: string | null;

	/** Active trip thread id (each trip is one thread). New trip = new id, previous trip stored in SQL and listed in trips. */
	currentTripId?: string | null;

	/** Sidebar list: past and current trips for display (id, title, createdAt). Full thread data in DO storage. */
	trips?: Array<{ id: string; title: string; createdAt: string }>;
}

/** Thread-level structured state (metadata + trip data) stored at `thread:{id}:state` */
type ThreadStateSnapshot = {
	title: string;
	createdAt: string;
	basics: TripBasics;
	preferences: string[];
	currentIntent: string | null;
};

/** Thread-level conversation history stored at `thread:{id}:history` */
type ThreadHistory = TravelState["recentMessages"];

/**
 * Travel Agent class that extends Agent for travel-related tasks
 */
export class TravelAgent extends Agent<Env, TravelState> {
	/**
	 * Initial state for the Travel Agent
	 */
	initialState: TravelState = {
		basics: {},
		preferences: [],
		currentItinerary: null,
		recentMessages: [],
		currentIntent: null,
		currentTripId: null,
		trips: [],
	};

	/**
	 * Amadeus API client instance (lazy initialization)
	 */
	private _amadeusClient: AmadeusClient | null = null;

	/** Whether we've loaded thread list and current thread from DO storage (avoids re-loading every request). */
	private _storageLoaded = false;

	/** Durable Object key-value storage (AgentContext = DurableObjectState). */
	private get doStorage(): DurableObjectStorage {
		const ctx = (this as unknown as { ctx: { storage: DurableObjectStorage } }).ctx;
		return ctx.storage;
	}

	/**
	 * Get or create Amadeus client instance
	 */
	private get amadeusClient(): AmadeusClient {
		if (!this._amadeusClient) {
			// Always use sandbox/test environment
			this._amadeusClient = new AmadeusClient({
				AMADEUS_API_KEY: this.env.AMADEUS_API_KEY,
				AMADEUS_API_SECRET: this.env.AMADEUS_API_SECRET,
			});
		}
		return this._amadeusClient;
	}

	/**
	 * Called when the agent is first created or restarted
	 */
	async onStart() {
		await this.ensureStateLoaded();
	}

	/** Load current thread and threads list from DO storage on first access. */
	private async ensureStateLoaded(): Promise<void> {
		if (this._storageLoaded) return;
		try {
			const currentThreadId = await this.doStorage.get<string>("currentThreadId");
			if (currentThreadId) {
				const [stateSnapshot, history] = await Promise.all([
					this.doStorage.get<ThreadStateSnapshot>(`thread:${currentThreadId}:state`),
					this.doStorage.get<ThreadHistory>(`thread:${currentThreadId}:history`),
				]);
				if (stateSnapshot) {
					this.setState({
						...this.state,
						currentTripId: currentThreadId,
						recentMessages: history ?? [],
						basics: stateSnapshot.basics ?? {},
						preferences: stateSnapshot.preferences ?? [],
						currentIntent: stateSnapshot.currentIntent ?? null,
					});
					console.log(
						"[TravelAgent] ensureStateLoaded: restored current thread",
						currentThreadId,
						"messages:",
						(history ?? []).length,
					);
				}
			}
			this._storageLoaded = true;
		} catch (e) {
			console.error("[TravelAgent] ensureStateLoaded error:", e);
			this._storageLoaded = true;
		}
	}

	/** Load list of saved threads from DO storage (single source of truth for sidebar). */
	private async getTripsListFromStorage(): Promise<Array<{ id: string; title: string; createdAt: string }>> {
		await this.ensureStateLoaded();
		try {
			const list = (await this.doStorage.get<Array<{ id: string; title: string; createdAt: string }>>("threads")) ?? [];
			console.log("[TravelAgent] getTripsListFromStorage: loaded", list.length, "saved thread(s)");
			return list;
		} catch (e) {
			console.error("[TravelAgent] getTripsListFromStorage error:", e);
			return [];
		}
	}

	/** Derive a short title for a trip from basics or first user message. */
	private deriveTripTitle(basics: TripBasics, recentMessages: TravelState["recentMessages"]): string {
		if (basics.destination?.trim()) return `Trip to ${basics.destination.trim()}`;
		const firstUser = recentMessages?.find((m) => m.role === "user");
		if (firstUser?.content) {
			const snippet = firstUser.content.trim().slice(0, 50);
			return snippet + (firstUser.content.length > 50 ? "…" : "");
		}
		return "New trip";
	}

	/** Persist current trip thread to DO storage, then reset current thread state. */
	private async saveCurrentTripAndStartNew(): Promise<void> {
		const id = this.state.currentTripId;
		if (!id) {
			console.log("[TravelAgent] saveCurrentTripAndStartNew: no currentTripId, skipping");
			return;
		}
		const title = this.deriveTripTitle(this.state.basics, this.state.recentMessages);
		const msgCount = (this.state.recentMessages ?? []).length;
		console.log("[TravelAgent] saveCurrentTripAndStartNew: saving thread", id, "title:", title, "messages:", msgCount);
		try {
			// Persist current thread state + history using shared helper
			await this.persistCurrentThread();
			console.log("[TravelAgent] saveCurrentTripAndStartNew: saved to DO storage, rotating to new thread");
		} catch (e) {
			console.error("[TravelAgent] saveCurrentTripAndStartNew error:", e);
			return;
		}
		const newId = crypto.randomUUID();
		this.setState({
			...this.state,
			currentTripId: newId,
			recentMessages: [],
			basics: {},
			preferences: [],
			currentIntent: null,
		});
		await this.doStorage.put("currentThreadId", newId);
		console.log("[TravelAgent] saveCurrentTripAndStartNew: new currentTripId", newId);
	}

	/** Load a trip from DO storage into current state (for sidebar switch). */
	private async loadTripFromStorage(tripId: string): Promise<boolean> {
		await this.ensureStateLoaded();
		try {
			const [stateSnapshot, history] = await Promise.all([
				this.doStorage.get<ThreadStateSnapshot>(`thread:${tripId}:state`),
				this.doStorage.get<ThreadHistory>(`thread:${tripId}:history`),
			]);
			if (!stateSnapshot) {
				console.log("[TravelAgent] loadTripFromStorage: no state for tripId", tripId);
				return false;
			}
			console.log(
				"[TravelAgent] loadTripFromStorage: loading thread",
				tripId,
				"title:",
				stateSnapshot.title,
				"messages:",
				(history ?? []).length,
			);
			this.setState({
				...this.state,
				currentTripId: tripId,
				basics: stateSnapshot.basics ?? {},
				preferences: stateSnapshot.preferences ?? [],
				recentMessages: history ?? [],
				currentIntent: stateSnapshot.currentIntent ?? null,
			});
			await this.doStorage.put("currentThreadId", tripId);
			return true;
		} catch (e) {
			console.error("[TravelAgent] loadTripFromStorage error:", e);
			return false;
		}
	}

	/** Persist current thread to DO storage (call after appendConversation or when switching away). */
	private async persistCurrentThread(): Promise<void> {
		const id = this.state.currentTripId;
		if (!id) return;
		try {
			const title = this.deriveTripTitle(this.state.basics, this.state.recentMessages);
			const snapshot: ThreadStateSnapshot = {
				title,
				createdAt: new Date().toISOString(),
				basics: this.state.basics ?? {},
				preferences: this.state.preferences ?? [],
				currentIntent: this.state.currentIntent ?? null,
			};
			const history: ThreadHistory = this.state.recentMessages ?? [];
			await Promise.all([
				this.doStorage.put(`thread:${id}:state`, snapshot),
				this.doStorage.put(`thread:${id}:history`, history),
			]);
			const threads = (await this.doStorage.get<Array<{ id: string; title: string; createdAt: string }>>("threads")) ?? [];
			const existing = threads.findIndex((t) => t.id === id);
			const entry = { id, title, createdAt: snapshot.createdAt };
			const next = existing >= 0 ? threads.map((t, i) => (i === existing ? entry : t)) : [entry, ...threads];
			await this.doStorage.put("threads", next);
		} catch (e) {
			console.error("[TravelAgent] persistCurrentThread error:", e);
		}
	}

	/**
	 * Override fetch to ensure our logging is called and all requests reach onRequest
	 */
	async fetch(request: Request): Promise<Response> {
		console.error(`[TravelAgent.fetch] Received ${request.method} request to ${request.url}`);
		const response = await this.onRequest(request);
		console.error(`[TravelAgent.fetch] Returning response with status ${response.status}`);
		return response;
	}

	/**
	 * Handle HTTP requests (including RPC requests)
	 * Implements RPC handling for @callable methods
	 */
	async onRequest(request: Request): Promise<Response> {
		console.error(`[TravelAgent.onRequest] Received ${request.method} request to ${request.url}`);

		// Handle GET requests - return method not allowed or endpoint info
		if (request.method === "GET") {
			const url = new URL(request.url);
			if (url.pathname.endsWith("/rpc")) {
				return Response.json(
					{
						error: "Method Not Allowed",
						message: "RPC endpoints only accept POST requests",
						usage: {
							method: "POST",
							contentType: "application/json",
							body: {
								type: "rpc",
								id: "unique-request-id",
								method: "methodName",
								args: ["arg1", "arg2"],
							},
						},
					},
					{ status: 405, headers: { Allow: "POST" } }
				);
			}
			return new Response("Not found", { status: 404 });
		}

		// Check if this is an RPC request (POST)
		if (request.method === "POST") {
			try {
				const body = await request.text();
				console.log("[TravelAgent] Request body:", body.substring(0, 200));
				const rpcData = JSON.parse(body) as {
					type: string;
					id: string;
					method: string;
					args: unknown[];
				};
				console.log("[TravelAgent] Parsed RPC data:", rpcData.type, rpcData.method);

				console.error(`[TravelAgent.onRequest] RPC call: method=${rpcData.method}, id=${rpcData.id}`);

				if (rpcData.type === "rpc" && rpcData.method) {
					console.error(`[TravelAgent.onRequest] RPC call: method=${rpcData.method}, id=${rpcData.id}`);

					// Try multiple lookup strategies
					let method: ((...args: any[]) => any) | undefined;
					method = (this as any)[rpcData.method];
					if (!method || typeof method !== "function") {
						const prototype = Object.getPrototypeOf(this) as any;
						method = prototype[rpcData.method];
					}
					if (!method || typeof method !== "function") {
						switch (rpcData.method) {
							case "testLLMRAGTools":
								method = this.testLLMRAGTools;
								break;
							case "handleMessage":
								method = this.handleMessage;
								break;
							case "handleMessageStreaming":
								method = this.handleMessageStreaming;
								break;
							case "callAmadeusAPI":
								method = this.callAmadeusAPI;
								break;
							case "getState":
								method = this.getState;
								break;
							case "appendConversation":
								method = this.appendConversation;
								break;
							case "prepareTurn":
								method = this.prepareTurn;
								break;
							case "loadTrip":
								method = this.loadTrip;
								break;
							case "startNewTrip":
								method = this.startNewTrip;
								break;
							case "clearRecentMessages":
								method = this.clearRecentMessages;
								break;
						}
					}
					if (method && typeof method === "function") {
						method = method.bind(this);
					}
					
					// Debug: List all available methods if method not found
					if (!method || typeof method !== "function") {
						const prototypeMethods = Object.getOwnPropertyNames(Object.getPrototypeOf(this))
							.filter(name => name !== 'constructor' && typeof (this as any)[name] === 'function');
						console.log("[TravelAgent] Prototype methods:", prototypeMethods);
						console.log("[TravelAgent] Looking for method:", rpcData.method);
						console.log("[TravelAgent] Method exists on this?", typeof (this as any)[rpcData.method]);
						console.log("[TravelAgent] testLLMRAGTools exists?", typeof this.testLLMRAGTools);
						console.log("[TravelAgent] All instance properties:", Object.getOwnPropertyNames(this));
					}
					
					if (method && typeof method === "function") {
						console.log("[TravelAgent] Method found, calling...");
						try {
							console.error(`[TravelAgent.onRequest] Calling method ${rpcData.method} with args:`, JSON.stringify(rpcData.args));
							// Call the method with the provided arguments
							const result = await method.apply(this, rpcData.args);
							console.error(`[TravelAgent.onRequest] Method ${rpcData.method} returned successfully`);

							// Handle ReadableStream results (for streaming methods like handleMessage)
							if (result instanceof ReadableStream) {
								// For RPC calls, we accumulate the stream and return full text (backward compatible)
								const accumulatedText = await this.accumulateStream(result);
								
								return Response.json({
									type: "rpc",
									id: rpcData.id,
									success: true,
									result: accumulatedText,
								});
							}

							// Return RPC response for non-stream results
							return Response.json({
								type: "rpc",
								id: rpcData.id,
								success: true,
								result: result,
							});
						} catch (error) {
							console.error(`[TravelAgent.onRequest] Error calling method ${rpcData.method}:`, error);
							return Response.json(
								{
									type: "rpc",
									id: rpcData.id,
									success: false,
									error: error instanceof Error ? error.message : String(error),
								},
								{ status: 500 }
							);
						}
					} else {
						return Response.json(
							{
								type: "rpc",
								id: rpcData.id,
								success: false,
								error: `Method ${rpcData.method} not found`,
							},
							{ status: 404 }
						);
					}
				}
			} catch (error) {
				// If JSON parsing fails, it's not an RPC request
				// Fall through to default handling
			}
		}

		// Path ends with /rpc but parsing failed - return 400
		const url = new URL(request.url);
		if (url.pathname.endsWith("/rpc") && request.method === "POST") {
			console.error("[TravelAgent] Path ends with /rpc but RPC parsing failed");
			return Response.json(
				{ type: "rpc", success: false, error: "Invalid RPC request format" },
				{ status: 400 }
			);
		}
		return new Response("Not found", { status: 404 });
	}


	/**
	 * Transform the LLM stream to accumulate full text for state storage
	 * Returns a new stream that forwards plain text chunks (not SSE) while accumulating the full response
	 */
	private transformStreamForState(
		stream: ReadableStream,
		userInput: string,
	): ReadableStream {
		let accumulatedText = "";
		const decoder = new TextDecoder();
		const encoder = new TextEncoder();
		const agent = this; // Capture 'this' for state update
		const parseSSE = this.parseSSEChunk.bind(this); // Bind parse method

		return new ReadableStream({
			async start(controller) {
				const reader = stream.getReader();
				let buffer = "";

				try {
					while (true) {
						const { done, value } = await reader.read();

						if (done) {
							// Process any remaining buffer
							if (buffer) {
								const parsed = parseSSE(buffer);
								for (const content of parsed.contents) {
									accumulatedText += content;
									// Forward the chunk as plain text (not SSE)
									controller.enqueue(encoder.encode(content));
								}
							}

							// Update state with complete response after streaming
							if (accumulatedText) {
								try {
									agent.setState({
										...agent.state,
										recentMessages: [
											...agent.state.recentMessages,
											{ role: "assistant" as const, content: accumulatedText },
										],
									});
								} catch (stateError) {
									console.error("[TravelAgent] Error updating state:", stateError);
									// Don't fail the stream if state update fails
								}
							}

							controller.close();
							break;
						}

						// Decode chunk and process SSE events
						buffer += decoder.decode(value, { stream: true });
						const parsed = parseSSE(buffer);
						buffer = parsed.buffer;

						// Forward each content chunk as plain text (immediately, not waiting for complete events)
						for (const content of parsed.contents) {
							accumulatedText += content;
							// Forward the chunk as plain text bytes (not SSE format)
							controller.enqueue(encoder.encode(content));
						}
					}
				} catch (error) {
					console.error("[TravelAgent] Stream transform error:", error);
					// Try to close gracefully instead of erroring
					try {
						controller.close();
					} catch (closeError) {
						console.error("[TravelAgent] Error closing stream controller:", closeError);
					}
				} finally {
					reader.releaseLock();
				}
			},
		});
	}

	/**
	 * Stream LLM response chunks to Realtime via RealtimeConnector
	 * Reads from ReadableStream and publishes progressive chunks to Realtime room
	 */
	private async streamToRealtime(
		stream: ReadableStream,
		roomId: string,
		userId?: string,
	): Promise<void> {
		console.log("[TravelAgent] streamToRealtime: Starting");
		
		if (!stream) {
			throw new Error("streamToRealtime: stream is null or undefined");
		}
		
		const reader = stream.getReader();
		const decoder = new TextDecoder();
		let chunkCount = 0;
		// Don't accumulate full text to avoid memory issues - just stream chunks

		try {
			// Get RealtimeConnector to publish chunks
			console.log("[TravelAgent] streamToRealtime: Checking for RealtimeConnector...");
			const realtimeConnector = (this.env as any).RealtimeConnector;
			console.log("[TravelAgent] streamToRealtime: RealtimeConnector available:", !!realtimeConnector);
			
			// Check if Realtime credentials are configured
			const hasRealtimeConfig = !!(this.env as any).REALTIME_API_TOKEN && !!(this.env as any).REALTIME_NAMESPACE_ID;
			console.log("[TravelAgent] streamToRealtime: Realtime credentials configured:", hasRealtimeConfig);
			
			if (!realtimeConnector) {
				console.error("[TravelAgent] streamToRealtime: RealtimeConnector not available in env");
				console.error("[TravelAgent] streamToRealtime: Available env keys:", Object.keys(this.env).filter(k => k.toLowerCase().includes('realtime')));
				// Don't throw - just log and continue (we'll accumulate and log the response)
				console.warn("[TravelAgent] streamToRealtime: RealtimeConnector not available, will accumulate response for logging");
				// Accumulate the stream and log it instead
				const accumulated = await this.accumulateStream(stream);
				console.log("[TravelAgent] streamToRealtime: Accumulated response (RealtimeConnector unavailable):", accumulated.substring(0, 200));
				return; // Exit early - can't publish without RealtimeConnector
			}

			const connectorId = realtimeConnector.idFromName("main");
			const stub = realtimeConnector.get(connectorId);
			console.log("[TravelAgent] streamToRealtime: Got RealtimeConnector stub");

			console.log("[TravelAgent] streamToRealtime: Publishing initial streaming message");
			// Publish initial response to indicate streaming has started
			try {
				const publishResponse = await stub.fetch(
					new Request("https://realtime-connector/publish", {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({
							room: roomId,
							message: {
								type: "agent_response",
								text: "",
								userId: userId,
								timestamp: Date.now(),
								streaming: true,
							},
						}),
					}),
				);
				console.log("[TravelAgent] streamToRealtime: Initial publish response status:", publishResponse.status);
				if (!publishResponse.ok) {
					const errorText = await publishResponse.text();
					console.error("[TravelAgent] streamToRealtime: Failed to publish initial message:", errorText);
				}
			} catch (publishError) {
				console.error("[TravelAgent] streamToRealtime: Error publishing initial message:", publishError);
				// Continue anyway - might be a transient error
			}

			console.log("[TravelAgent] streamToRealtime: Starting to read stream");

			while (true) {
				const { done, value } = await reader.read();

				if (done) {
					console.log("[TravelAgent] streamToRealtime: Stream done, processing final chunk");
					// Decode any remaining bytes in the decoder's internal buffer
					try {
						const finalChunk = decoder.decode();
						if (finalChunk && finalChunk.trim().length > 0) {
							chunkCount++;
							// Publish final chunk
							await stub.fetch(
								new Request("https://realtime-connector/publish", {
									method: "POST",
									headers: { "Content-Type": "application/json" },
									body: JSON.stringify({
										room: roomId,
										message: {
											type: "agent_response",
											text: finalChunk,
											userId: userId,
											timestamp: Date.now(),
											chunk: true,
										},
									}),
								}),
							);
						}
					} catch (decodeError) {
						console.error("[TravelAgent] Error decoding final chunk:", decodeError);
					}

					// Publish final complete message (without full text to save memory)
					await stub.fetch(
						new Request("https://realtime-connector/publish", {
							method: "POST",
							headers: { "Content-Type": "application/json" },
							body: JSON.stringify({
								room: roomId,
								message: {
									type: "agent_response",
									text: "", // Don't send full text to avoid memory issues
									userId: userId,
									timestamp: Date.now(),
									complete: true,
								},
							}),
						}),
					);
					console.log(`[TravelAgent] streamToRealtime: Stream complete. Total chunks: ${chunkCount}`);
					break;
				}

				// Decode chunk (plain text, not SSE)
				const chunk = decoder.decode(value, { stream: true });
				
				// Only send non-empty chunks
				if (chunk && chunk.trim().length > 0) {
					chunkCount++;
					
					// Publish chunk immediately
					try {
						const chunkResponse = await stub.fetch(
							new Request("https://realtime-connector/publish", {
								method: "POST",
								headers: { "Content-Type": "application/json" },
								body: JSON.stringify({
									room: roomId,
									message: {
										type: "agent_response",
										text: chunk,
										userId: userId,
										timestamp: Date.now(),
										chunk: true,
									},
								}),
							}),
						);
						if (!chunkResponse.ok && chunkCount <= 3) {
							const errorText = await chunkResponse.text();
							console.error(`[TravelAgent] streamToRealtime: Failed to publish chunk ${chunkCount}:`, errorText);
						}
					} catch (chunkError) {
						console.error(`[TravelAgent] streamToRealtime: Error publishing chunk ${chunkCount}:`, chunkError);
						// Continue streaming even if publish fails
					}
					
					// Log first few chunks for debugging
					if (chunkCount <= 3) {
						console.log(`[TravelAgent] streamToRealtime: Published chunk ${chunkCount}: "${chunk.substring(0, 30)}..."`);
					}
				}
			}
		} catch (error) {
			console.error("[TravelAgent] Error streaming to Realtime:", error);
			// Try to publish error message
			try {
				const realtimeConnector = (this.env as any).RealtimeConnector;
				if (realtimeConnector) {
					const connectorId = realtimeConnector.idFromName("main");
					const stub = realtimeConnector.get(connectorId);
					await stub.fetch(
						new Request("https://realtime-connector/publish", {
							method: "POST",
							headers: { "Content-Type": "application/json" },
							body: JSON.stringify({
								room: roomId,
								message: {
									type: "agent_response",
									text: error instanceof Error ? error.message : "Streaming error",
									userId: userId,
									timestamp: Date.now(),
									isError: true,
								},
							}),
						}),
					);
				}
			} catch (publishError) {
				console.error("[TravelAgent] Failed to publish error message:", publishError);
			}
			throw error;
		} finally {
			reader.releaseLock();
		}
	}

	/**
	 * Accumulate a ReadableStream into a complete string
	 * Used for RPC calls that need the full response (backward compatibility)
	 * Added memory limit to prevent Durable Object memory exhaustion
	 */
	private async accumulateStream(stream: ReadableStream, maxLength: number = 10000): Promise<string> {
		const reader = stream.getReader();
		const decoder = new TextDecoder();
		let buffer = "";
		let accumulatedText = "";
		let totalLength = 0;

		try {
			while (true) {
				const { done, value } = await reader.read();

				if (done) {
					// Process any remaining buffer
					if (buffer) {
						const parsed = this.parseSSEChunk(buffer);
						for (const content of parsed.contents) {
							if (totalLength + content.length > maxLength) {
								accumulatedText += content.substring(0, maxLength - totalLength);
								console.warn(`[TravelAgent] accumulateStream: Reached memory limit (${maxLength} chars), truncating`);
								break;
							}
							accumulatedText += content;
							totalLength += content.length;
						}
					}
					break;
				}

				// Decode chunk and process SSE events
				buffer += decoder.decode(value, { stream: true });
				const parsed = this.parseSSEChunk(buffer);
				buffer = parsed.buffer;

				// Accumulate each content chunk with memory limit
				for (const content of parsed.contents) {
					if (totalLength + content.length > maxLength) {
						accumulatedText += content.substring(0, maxLength - totalLength);
						console.warn(`[TravelAgent] accumulateStream: Reached memory limit (${maxLength} chars), truncating`);
						break;
					}
					accumulatedText += content;
					totalLength += content.length;
				}
				
				// Break if we've reached the limit
				if (totalLength >= maxLength) {
					break;
				}
			}
		} finally {
			reader.releaseLock();
		}

		return accumulatedText;
	}

	/**
	 * Parse Server-Sent Events (SSE) chunks to extract content
	 * Workers AI returns SSE format: "data: {...}\n\n"
	 * This method processes complete SSE events and returns any remaining partial buffer
	 */
	private parseSSEChunk(buffer: string): { contents: string[]; buffer: string } {
		const contents: string[] = [];
		let remainingBuffer = buffer;

		// Normalize line endings
		const normalized = remainingBuffer.replace(/\r/g, "");
		
		// Find complete SSE events (ending with \n\n)
		let eventEndIndex;
		while ((eventEndIndex = normalized.indexOf("\n\n")) !== -1) {
			const rawEvent = normalized.slice(0, eventEndIndex);
			remainingBuffer = normalized.slice(eventEndIndex + 2);
			
			const lines = rawEvent.split("\n");
			for (const line of lines) {
				if (line.startsWith("data:")) {
					const data = line.slice("data:".length).trimStart();
					
					// Skip [DONE] marker
					if (data === "[DONE]") {
						continue;
					}
					
					try {
						const jsonData = JSON.parse(data);
						// Extract content from Workers AI response format
						if (typeof jsonData.response === "string" && jsonData.response.length > 0) {
							contents.push(jsonData.response);
						} else if (jsonData.choices?.[0]?.delta?.content) {
							// OpenAI-style format
							const deltaContent = jsonData.choices[0].delta.content;
							if (deltaContent && typeof deltaContent === "string") {
								contents.push(deltaContent);
							}
						} else if (jsonData.content) {
							// Alternative format
							if (typeof jsonData.content === "string" && jsonData.content.length > 0) {
								contents.push(jsonData.content);
							}
						}
					} catch (e) {
						// If not JSON, treat as plain text
						if (data && data !== "[DONE]") {
							contents.push(data);
						}
					}
				}
			}
		}

		return { contents, buffer: remainingBuffer };
	}

	// ============================================================================
	// AMADEUS API - Single Generic Method for Official 30 APIs
	// ============================================================================

	/**
	 * Generic method to call any official Amadeus API (30 APIs total)
	 * Based on official Amadeus API Usage page for "travellite" app
	 * @param apiName - Name of the API method to call
	 * @param params - Parameters for the API call (varies by API)
	 * @returns Standardized response: { success: true, data: result } or { success: false, error: string }
	 */
	@callable({ description: "Call any official Amadeus API by name. Flight APIs (19): searchFlightOffers, getFlightOfferPrice, searchFlightDestinations, searchCheapestFlightDates, getMostTraveledDestinations, getMostBookedDestinations, getBusiestPeriod, getFlightAvailabilities, getSeatmap, getFlightStatus, searchAirlines, getAirlineRoutes, searchLocations, getAirportNearestRelevant, getAirportRoutes, getBrandedFaresUpsell, getFlightCheckinLinks, getAirportOnTimePerformance, searchCities. Hotel APIs (4): searchHotelsByGeocode, searchHotelsByCity, searchHotelOffers, searchHotelNameAutocomplete, getHotelRatings. Destination Experience (2): searchCities, searchActivities, getActivity. Transfer (1): searchTransfers. Other (1): getRecommendedLocations" })
	async callAmadeusAPI(apiName: string, params?: any) {
		try {
			// Map API names to client methods and handle parameter transformations
			let result: any;

			switch (apiName) {
				// ========================================================================
				// FLIGHT APIs (19 APIs)
				// ========================================================================
				case "searchFlightOffers":
					result = await this.amadeusClient.searchFlightOffers({
						originLocationCode: params?.origin || params?.originLocationCode,
						destinationLocationCode: params?.destination || params?.destinationLocationCode,
						departureDate: params?.departureDate,
						returnDate: params?.returnDate,
						adults: params?.adults,
						children: params?.children,
						infants: params?.infants,
						travelClass: params?.travelClass,
						nonStop: params?.nonStop,
						max: params?.max,
					});
					break;
				case "getFlightOfferPrice":
					result = await this.amadeusClient.getFlightOfferPrice(params?.flightOffer || params);
					break;
				case "searchFlightDestinations":
					result = await this.amadeusClient.searchFlightDestinations(params);
					break;
				case "searchCheapestFlightDates":
					result = await this.amadeusClient.searchCheapestFlightDates(params);
					break;
				case "getMostTraveledDestinations":
					result = await this.amadeusClient.getMostTraveledDestinations(params);
					break;
				case "getMostBookedDestinations":
					result = await this.amadeusClient.getMostBookedDestinations(params);
					break;
				case "getBusiestPeriod":
					result = await this.amadeusClient.getBusiestPeriod(params);
					break;
				case "getFlightAvailabilities":
					result = await this.amadeusClient.getFlightAvailabilities(params);
					break;
				case "getSeatmap":
					result = await this.amadeusClient.getSeatmap(params?.flightOffer || params);
					break;
				case "getFlightStatus":
					result = await this.amadeusClient.getFlightStatus(params);
					break;
				case "searchAirlines":
					result = await this.amadeusClient.searchAirlines(params);
					break;
				case "getAirlineRoutes":
					result = await this.amadeusClient.getAirlineRoutes(params);
					break;
				case "searchLocations":
					result = await this.amadeusClient.searchLocations(params);
					break;
				case "getAirportNearestRelevant":
					result = await this.amadeusClient.getAirportNearestRelevant(params);
					break;
				case "getAirportRoutes":
					result = await this.amadeusClient.getAirportRoutes(params);
					break;
				case "getBrandedFaresUpsell":
					result = await this.amadeusClient.getBrandedFaresUpsell({
						flightOffer: params?.flightOffer || params,
					});
					break;
				case "getFlightCheckinLinks":
					result = await this.amadeusClient.getFlightCheckinLinks(params);
					break;
				case "getAirportOnTimePerformance":
					result = await this.amadeusClient.getAirportOnTimePerformance(params);
					break;
				case "searchCities":
					result = await this.amadeusClient.searchCities(params);
					break;

				// ========================================================================
				// HOTEL APIs (4 APIs)
				// ========================================================================
				case "searchHotelsByGeocode":
					result = await this.amadeusClient.searchHotelsByGeocode(params);
					break;
				case "searchHotelsByCity":
					result = await this.amadeusClient.searchHotelsByCity(params);
					break;
				case "searchHotelOffers":
					result = await this.amadeusClient.searchHotelOffers(params);
					break;
				case "searchHotelNameAutocomplete":
					result = await this.amadeusClient.searchHotelNameAutocomplete(params);
					break;
				case "getHotelRatings":
					result = await this.amadeusClient.getHotelRatings(params);
					break;

				// ========================================================================
				// DESTINATION EXPERIENCE APIs (2 APIs)
				// ========================================================================
				// Note: searchCities is already handled above in Flight APIs
				case "searchActivities":
					result = await this.amadeusClient.searchActivities(params);
					break;
				case "getActivity":
					result = await this.amadeusClient.getActivity(params?.activityId || params, params?.lang ? { lang: params.lang } : undefined);
					break;

				// ========================================================================
				// TRANSFER/TRANSPORTATION APIs (1 API)
				// ========================================================================
				case "searchTransfers":
					result = await this.amadeusClient.searchTransfers(params);
					break;

				// ========================================================================
				// OTHER APIs (1 API)
				// ========================================================================
				case "getRecommendedLocations":
					result = await this.amadeusClient.getRecommendedLocations(params);
					break;

				default:
					return {
						success: false,
						error: `Unknown API: ${apiName}. Available APIs: searchFlightOffers, getFlightOfferPrice, searchFlightDestinations, searchCheapestFlightDates, getMostTraveledDestinations, getMostBookedDestinations, getBusiestPeriod, getFlightAvailabilities, getSeatmap, getFlightStatus, searchAirlines, getAirlineRoutes, searchLocations, getAirportNearestRelevant, getAirportRoutes, getBrandedFaresUpsell, getFlightCheckinLinks, getAirportOnTimePerformance, searchCities, searchHotelsByGeocode, searchHotelsByCity, searchHotelOffers, searchHotelNameAutocomplete, getHotelRatings, searchActivities, getActivity, searchTransfers, getRecommendedLocations`,
					};
			}

			return { success: true, data: result };
		} catch (error) {
			return {
				success: false,
				error: error instanceof Error ? error.message : `Failed to call ${apiName}`,
			};
		}
	}

	/** Max conversation messages to keep in state (10 turns). */
	private static readonly MAX_RECENT_MESSAGES = 20;

	@callable({ description: "Return current trip state and conversation history for session memory" })
	async getState(): Promise<{
		basics: TripBasics;
		preferences: string[];
		recentMessages: TravelState["recentMessages"];
		currentIntent: string | null;
		currentTripId: string | null;
		trips: Array<{ id: string; title: string; createdAt: string }>;
		currentTripTitle: string;
	}> {
		await this.ensureStateLoaded();
		const savedTrips = await this.getTripsListFromStorage();
		console.log("[TravelAgent] getState: currentTripId", this.state.currentTripId ?? "null", "recentMessages", (this.state.recentMessages ?? []).length, "savedTrips", savedTrips.length);
		const currentId = this.state.currentTripId ?? null;
		const currentTitle = this.deriveTripTitle(this.state.basics, this.state.recentMessages);
		// Always include current thread in list (so "New trip" / blank chat appears in sidebar and can be selected)
		const currentEntry = currentId ? { id: currentId, title: currentTitle, createdAt: new Date().toISOString() } : null;
		const savedWithoutCurrent = currentId ? savedTrips.filter((t) => t.id !== currentId) : savedTrips;
		const trips = currentEntry ? [currentEntry, ...savedWithoutCurrent] : savedWithoutCurrent;
		return {
			basics: this.state.basics,
			preferences: [...this.state.preferences],
			recentMessages: this.state.recentMessages.slice(-TravelAgent.MAX_RECENT_MESSAGES),
			currentIntent: this.state.currentIntent ?? null,
			currentTripId: currentId,
			trips,
			currentTripTitle: currentTitle,
		};
	}

	/**
	 * Call before processing a message: ensure trip id, classify intent + new trip (one LLM call), save thread if new trip, set intent, return state.
	 * Used by the Worker stream path so the DO is the source of truth for trip switching and intent.
	 */
	@callable({ description: "Prepare turn: ensure trip id, classify intent and new trip, save/rotate if needed, set intent; return state" })
	async prepareTurn(message: string): Promise<Awaited<ReturnType<TravelAgent["getState"]>>> {
		await this.ensureStateLoaded();
		if (!this.state.currentTripId) {
			const newId = crypto.randomUUID();
			this.setState({ ...this.state, currentTripId: newId });
			await this.doStorage.put("currentThreadId", newId);
		}
		const hasExisting = (this.state.recentMessages?.length ?? 0) > 0;
		const currentBasics = { destination: this.state.basics?.destination, origin: this.state.basics?.origin };
		const { intent, isNewTrip } = await classifyConversation(
			this.env as Env,
			message,
			this.state.currentIntent ?? null,
			currentBasics,
			hasExisting,
		);
		console.log("[TravelAgent] prepareTurn: isNewTrip", isNewTrip, "intent", intent ?? "null", "hasExisting", hasExisting);
		if (isNewTrip) await this.saveCurrentTripAndStartNew();
		this.setState({ ...this.state, currentIntent: intent });
		return this.getState();
	}

	@callable({ description: "Load a trip thread by id into current state (for sidebar switch)" })
	async loadTrip(tripId: string): Promise<{ success: boolean }> {
		console.log("[TravelAgent] loadTrip: tripId", tripId);
		const ok = await this.loadTripFromStorage(tripId);
		console.log("[TravelAgent] loadTrip: success", ok);
		return { success: ok };
	}

	@callable({ description: "Start a new trip thread (saves current thread to storage and switches to a fresh one)" })
	async startNewTrip(): Promise<Awaited<ReturnType<TravelAgent["getState"]>>> {
		await this.ensureStateLoaded();
		await this.saveCurrentTripAndStartNew();
		if (!this.state.currentTripId) {
			const newId = crypto.randomUUID();
			this.setState({ ...this.state, currentTripId: newId });
			await this.doStorage.put("currentThreadId", newId);
		}
		console.log("[TravelAgent] startNewTrip: new currentTripId", this.state.currentTripId);
		return this.getState();
	}

	@callable({ description: "One-time hard clear of all recentMessages for this session" })
	async clearRecentMessages(): Promise<{ success: boolean }> {
		console.log("[TravelAgent] clearRecentMessages: clearing recentMessages");
		this.setState({ ...this.state, recentMessages: [] });
		return { success: true };
	}

	@callable({ description: "Append user and assistant messages to conversation history and persist" })
	async appendConversation(
		userMessage: string,
		assistantMessage: string,
		stateUpdate?: { currentIntent?: string | null },
	): Promise<{ success: boolean }> {
		this.extractTripInfo(userMessage);
		const next = [
			...this.state.recentMessages,
			{ role: "user" as const, content: userMessage },
			{ role: "assistant" as const, content: assistantMessage },
		].slice(-TravelAgent.MAX_RECENT_MESSAGES);
		const nextState = { ...this.state, recentMessages: next };
		if (stateUpdate && "currentIntent" in stateUpdate) {
			nextState.currentIntent = stateUpdate.currentIntent ?? null;
		}
		this.setState(nextState);
		await this.persistCurrentThread();
		return { success: true };
	}

	/**
	 * Main message handler that orchestrates RAG, tools, and LLM
	 * @param input User's message input
	 * @returns ReadableStream for streaming token-by-token responses
	 */
	/**
	 * Handle message with streaming via Realtime.
	 * Single door: webhook routes here; DO runs RAG + tools + LLM and streams via RealtimeConnector.
	 */
	@callable({ description: "Handle user message with RAG, tools, and LLM, streaming to Realtime" })
	async handleMessageStreaming(
		input: string,
		roomId: string,
		userId?: string,
	): Promise<{ success: boolean; message?: string; error?: string }> {
		console.log("[TravelAgent] handleMessageStreaming: Starting");

		// Trip threads + intent: one classifier in prepareTurn (saves thread if new trip, sets currentIntent)
		await this.prepareTurn(input);

		this.extractTripInfo(input);
		this.setState({
			...this.state,
			recentMessages: [
				...this.state.recentMessages,
				{ role: "user" as const, content: input },
			].slice(-TravelAgent.MAX_RECENT_MESSAGES),
		});

		const tripState: PipelineTripState = {
			basics: this.state.basics,
			preferences: this.state.preferences,
			recentMessages: this.state.recentMessages,
			currentIntent: this.state.currentIntent ?? null,
		};

		// Run pipeline with history, stream to Realtime, and persist assistant response when done
		(async () => {
			try {
				const stream = await runPipeline(this.env as Env, input, tripState);
				const streamWithAccumulator = this.transformStreamForState(stream, input);
				await this.streamToRealtime(streamWithAccumulator, roomId, userId);
				console.log("[TravelAgent] handleMessageStreaming: Streaming completed in background");
			} catch (error) {
				console.error("[TravelAgent] handleMessageStreaming: Error in background processing:", error);
				console.error(
					"[TravelAgent] handleMessageStreaming: Error stack:",
					error instanceof Error ? error.stack : "No stack trace",
				);
				// Try to publish error to Realtime
				const realtimeConnector = (this.env as any).RealtimeConnector;
				if (realtimeConnector) {
					const connectorId = realtimeConnector.idFromName("main");
					const stub = realtimeConnector.get(connectorId);
					try {
						await stub.fetch(
							new Request("https://realtime-connector/publish", {
								method: "POST",
								headers: { "Content-Type": "application/json" },
								body: JSON.stringify({
									room: roomId,
									message: {
										type: "agent_response",
										text: `Error: ${
											error instanceof Error ? error.message : "Streaming failed"
										}`,
										userId: userId,
										timestamp: Date.now(),
										isError: true,
									},
								}),
							}),
						);
					} catch (publishError) {
						console.error(
							"[TravelAgent] handleMessageStreaming: Failed to publish error:",
							publishError,
						);
					}
				}
			}
		})();

		// Return immediately - all work happens in background
		return { success: true, message: "Processing started" };
	}

	@callable({ description: "Test LLM, RAG, and tools without accumulating full response" })
	async testLLMRAGTools(input: string): Promise<{ 
		success: boolean; 
		ragTriggered: boolean; 
		toolsTriggered: boolean; 
		ragContextLength: number; 
		toolResultsLength: number; 
		llmStarted: boolean;
		preview: string;
	}> {
		console.log("[TravelAgent] testLLMRAGTools: Starting, input:", input.substring(0, 50));
		
		// 1. Check if RAG and tools are needed
		const needsRAG = this.shouldUseRAG(input);
		const needsTools = this.shouldUseTools(input);
		console.log("[TravelAgent] testLLMRAGTools: RAG needed:", needsRAG, "Tools needed:", needsTools);

		// 2. Run RAG and tools in parallel with timeouts
		const ragPromise = needsRAG
			? Promise.race([
					this.performRAG(input),
					new Promise<string>((resolve) => setTimeout(() => resolve(""), 5000)),
				])
			: Promise.resolve("");

		const toolsPromise = needsTools
			? Promise.race([
					this.useTools(input),
					new Promise<string>((resolve) => setTimeout(() => resolve(""), 10000)),
				])
			: Promise.resolve("");

		console.log("[TravelAgent] testLLMRAGTools: Running RAG and tools in parallel...");
		const [ragResult, toolsResult] = await Promise.all([ragPromise, toolsPromise]);
		
		console.log("[TravelAgent] testLLMRAGTools: RAG context length:", ragResult.length, "Tool results length:", toolsResult.length);

		// 3. Test LLM generation (just get a small preview, don't accumulate full response)
		let llmStarted = false;
		let preview = "";
		
		try {
			console.log("[TravelAgent] testLLMRAGTools: Testing LLM generation...");
			const stream = await this.generateLLMResponse(input, ragResult, toolsResult);
			llmStarted = true;
			
			// Read just the first few chunks to verify LLM is working
			const reader = stream.getReader();
			const decoder = new TextDecoder();
			let chunkCount = 0;
			const maxChunks = 5; // Only read first 5 chunks
			
			try {
				while (chunkCount < maxChunks) {
					const { done, value } = await reader.read();
					if (done) break;
					
					const chunk = decoder.decode(value, { stream: true });
					preview += chunk;
					chunkCount++;
					
					// Limit preview to 500 chars
					if (preview.length > 500) {
						preview = preview.substring(0, 500) + "...";
						break;
					}
				}
			} finally {
				reader.releaseLock();
			}
			
			console.log("[TravelAgent] testLLMRAGTools: LLM preview length:", preview.length);
		} catch (error) {
			console.error("[TravelAgent] testLLMRAGTools: LLM error:", error);
		}

		return {
			success: true,
			ragTriggered: needsRAG,
			toolsTriggered: needsTools,
			ragContextLength: ragResult.length,
			toolResultsLength: toolsResult.length,
			llmStarted: llmStarted,
			preview: preview,
		};
	}

	@callable({ description: "Handle user message with RAG, tools, and LLM" })
	async handleMessage(input: string): Promise<ReadableStream> {
		const handleMessageStartTime = Date.now();
		console.error(`[handleMessage] Starting handleMessage() at ${new Date().toISOString()}`);

		// 0. Trip threads + intent: one classifier in prepareTurn (saves thread if new trip, sets currentIntent)
		await this.prepareTurn(input);

		this.extractTripInfo(input);
		this.setState({
			...this.state,
			recentMessages: [
				...this.state.recentMessages,
				{ role: "user" as const, content: input },
			].slice(-TravelAgent.MAX_RECENT_MESSAGES),
		});

		// 2. Run shared pipeline with conversation history and current intent
		const tripState: PipelineTripState = {
			basics: this.state.basics,
			preferences: this.state.preferences,
			recentMessages: this.state.recentMessages,
			currentIntent: this.state.currentIntent ?? null,
		};

		let stream: ReadableStream;
		try {
			stream = await runPipeline(this.env as Env, input, tripState);
		} catch (error) {
			console.error("[TravelAgent] handleMessage: Error running pipeline:", error);
			throw error;
		}

		// 4. Transform stream to accumulate full response for state
		const totalDuration = Date.now() - handleMessageStartTime;
		console.error(`[handleMessage] Total execution time: ${totalDuration}ms`);
		try {
			return this.transformStreamForState(stream, input);
		} catch (transformError) {
			console.error("[TravelAgent] handleMessage: Error in transformStreamForState:", transformError);
			throw transformError;
		}
	}

	/**
	 * Extract trip information from user message and update state
	 */
	private extractTripInfo(message: string): void {
		const lowerMessage = message.toLowerCase();
		const updates: Partial<TravelState> = {};

		// Extract origin (departure city for flights)
		const originMatch = message.match(
			/(?:departing from|flying from|fly from|leaving from|from)\s+([A-Z]{3}|[A-Z][a-zA-Z\s]+?)(?:\s|,|\.|$)/i,
		);
		if (originMatch && !this.state.basics.origin) {
			const origin = originMatch[1].trim();
			if (origin.length >= 2 && !/^\d{4}-\d{2}-\d{2}$/.test(origin) && !/^(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i.test(origin)) {
				updates.basics = {
					...this.state.basics,
					...updates.basics,
					origin,
				};
			}
		}

		// Extract destination
		const destinationMatch = message.match(
			/(?:going to|visit|travel to|destination|trip to)\s+([A-Z][a-zA-Z\s]+)/i,
		);
		if (destinationMatch && !this.state.basics.destination) {
			updates.basics = {
				...this.state.basics,
				...updates.basics,
				destination: destinationMatch[1].trim(),
			};
		}

		// Extract dates
		const dateMatch = message.match(
			/(?:from|depart|start|leaving)\s+(\d{4}-\d{2}-\d{2}|\w+\s+\d{1,2})/i,
		);
		if (dateMatch && !this.state.basics.startDate) {
			updates.basics = {
				...this.state.basics,
				startDate: dateMatch[1],
			};
		}

		const endDateMatch = message.match(
			/(?:until|return|end|coming back|until)\s+(\d{4}-\d{2}-\d{2}|\w+\s+\d{1,2})/i,
		);
		if (endDateMatch && !this.state.basics.endDate) {
			updates.basics = {
				...this.state.basics,
				endDate: endDateMatch[1],
			};
		}

		// Extract budget
		const budgetMatch = message.match(/\$?(\d+(?:,\d{3})*(?:\.\d{2})?)/);
		if (budgetMatch && !this.state.basics.budget) {
			updates.basics = {
				...this.state.basics,
				budget: parseFloat(budgetMatch[1].replace(/,/g, "")),
			};
		}

		// Extract preferences
		const preferenceKeywords = [
			"nightlife",
			"coffee",
			"walkable",
			"beach",
			"museums",
			"hiking",
			"food",
			"shopping",
			"culture",
			"nature",
		];
		const foundPreferences = preferenceKeywords.filter((pref) =>
			lowerMessage.includes(pref),
		);
		if (foundPreferences.length > 0) {
			updates.preferences = [
				...new Set([...this.state.preferences, ...foundPreferences]),
			];
		}

		// Apply updates if any
		if (Object.keys(updates).length > 0) {
			this.setState({
				...this.state,
				...updates,
			});
		}
	}

	/**
	 * Determine if RAG (Vectorize) should be used
	 */
	private shouldUseRAG(message: string): boolean {
		const ragKeywords = [
			"recommend",
			"suggest",
			"what to do",
			"attractions",
			"places to visit",
			"activities",
			"things to see",
		];
		const lowerMessage = message.toLowerCase();
		return ragKeywords.some((keyword) => lowerMessage.includes(keyword));
	}

	/**
	 * Generate embedding for text using Workers AI
	 */
	private async generateEmbedding(text: string): Promise<number[]> {
		try {
			const response = await this.env.AI.run("@cf/baai/bge-base-en-v1.5", {
				text: [text],
			});

			// Extract embedding from response
			if (response && typeof response === "object" && "data" in response) {
				const data = response.data as any;
				if (Array.isArray(data) && data.length > 0 && Array.isArray(data[0])) {
					return data[0];
				}
				if (Array.isArray(data)) {
					return data;
				}
			}

			throw new Error("Unexpected embedding response format");
		} catch (error) {
			console.error("Embedding generation error:", error);
			throw error;
		}
	}

	/**
	 * Perform RAG search using Vectorize
	 */
	private async performRAG(query: string): Promise<string> {
		try {
			// Generate embedding for the query
			const queryEmbedding = await this.generateEmbedding(query);

			// Build filter based on current trip state
			const filter: Record<string, string> = {};
			if (this.state.basics.destination) {
				// Try to extract city code or use destination name
				filter.city = this.state.basics.destination;
			}

			// Query Vectorize index
			const queryResult = await this.env.VECTORIZE.query(queryEmbedding, {
				topK: 5,
				filter: Object.keys(filter).length > 0 ? filter : undefined,
			});

			if (!queryResult || !queryResult.matches || queryResult.matches.length === 0) {
				return "";
			}

			// Format results into context paragraphs
			const contextParagraphs = queryResult.matches
				.map((match: any, index: number) => {
					const metadata = match.metadata || {};
					const source = metadata.source || "travel knowledge base";
					const type = metadata.type || "general";
					const topic = metadata.topic || "";
					const text = metadata.text || ""; // Retrieve stored text
					
					// Use stored text if available, otherwise construct from metadata
					const contextText = text || (topic 
						? `Information about ${topic} (${type})`
						: `Travel information (${type})`);
					
					return `[${index + 1}] ${contextText} (Source: ${source}, Score: ${match.score?.toFixed(3) || "N/A"})`;
				})
				.join("\n\n");

			return contextParagraphs;
		} catch (error) {
			console.error("RAG search error:", error);
			return "";
		}
	}

	/**
	 * Ingest Amadeus result into Vectorize with deduplication
	 * @param result - Normalized Amadeus API result
	 * @param type - Type of result: "hotel", "flight", "activity", "poi", etc.
	 * @param city - City/location for the result
	 */
	private async ingestAmadeusResult(
		result: any,
		type: string,
		city?: string,
	): Promise<void> {
		try {
			// Extract Amadeus ID from result
			const amadeusId = result.id || result.hotelId || result.activityId || result.poiId || null;
			if (!amadeusId) {
				console.warn("Cannot ingest result without ID");
				return;
			}

			// Check KV for deduplication
			const kvKey = `amadeus:${type}:${amadeusId}`;
			const existing = await this.env.KVNAMESPACE.get(kvKey);
			
			if (existing) {
				// Already ingested, skip
				console.log(`Skipping duplicate: ${kvKey}`);
				return;
			}

			// Build summary based on type
			let summary = "";
			const tags: string[] = [];

			switch (type) {
				case "hotel":
					summary = this.summarizeHotel(result);
					if (result.price) tags.push("hotel");
					if (result.rating) tags.push(`rating-${Math.floor(result.rating)}`);
					break;
				case "flight":
					summary = this.summarizeFlight(result);
					tags.push("flight");
					if (result.price) {
						const price = parseFloat(result.price.total || result.price);
						if (price < 300) tags.push("budget");
						else if (price < 800) tags.push("midrange");
						else tags.push("premium");
					}
					break;
				case "activity":
					summary = this.summarizeActivity(result);
					tags.push("activity");
					if (result.category) tags.push(result.category.toLowerCase());
					break;
				default:
					summary = JSON.stringify(result).substring(0, 500);
					tags.push(type);
			}

			if (!summary || summary.length < 20) {
				console.warn("Summary too short, skipping ingestion");
				return;
			}

			// Generate embedding
			const embedding = await this.generateEmbedding(summary);

			// Prepare metadata (include summary text for retrieval)
			const metadata = {
				amadeusId: String(amadeusId),
				city: city || this.state.basics.destination || "unknown",
				type: type,
				tags: tags.join(","),
				createdAt: Date.now(),
				source: "amadeus",
				text: summary, // Store summary text for retrieval
			};

			// Upsert to Vectorize
			await this.env.VECTORIZE.upsert([
				{
					id: `amadeus-${type}-${amadeusId}`,
					values: embedding,
					metadata: metadata,
				},
			]);

			// Store in KV to mark as ingested
			await this.env.KVNAMESPACE.put(kvKey, JSON.stringify({
				ingestedAt: Date.now(),
				type: type,
				city: city,
			}));

			console.log(`Ingested ${type} ${amadeusId} into Vectorize`);
		} catch (error) {
			console.error("Error ingesting Amadeus result:", error);
			// Don't throw - ingestion failures shouldn't break the flow
		}
	}

	/**
	 * Summarize hotel result for RAG ingestion
	 */
	private summarizeHotel(hotel: any): string {
		const name = hotel.name || hotel.hotelName || "Hotel";
		const city = hotel.address?.cityName || hotel.cityCode || "";
		const price = hotel.price?.total || hotel.price?.base || "";
		const rating = hotel.rating || hotel.starRating || "";
		const amenities = hotel.amenities || [];
		
		let summary = `${name}`;
		if (city) summary += ` in ${city}`;
		if (rating) summary += ` (${rating}-star)`;
		if (price) summary += `, typically ${price}`;
		if (amenities.length > 0) {
			summary += `. Features: ${amenities.slice(0, 3).join(", ")}`;
		}
		
		return summary;
	}

	/**
	 * Summarize flight result for RAG ingestion
	 */
	private summarizeFlight(flight: any): string {
		const origin = flight.origin?.iataCode || flight.originLocationCode || "";
		const destination = flight.destination?.iataCode || flight.destinationLocationCode || "";
		const price = flight.price?.total || flight.price?.grandTotal || "";
		const duration = flight.duration || "";
		const stops = flight.numberOfBookableSeats !== undefined ? "non-stop" : "with stops";
		
		let summary = `Flight from ${origin} to ${destination}`;
		if (price) summary += ` for ${price}`;
		if (duration) summary += `, duration ${duration}`;
		summary += ` (${stops})`;
		
		return summary;
	}

	/**
	 * Summarize activity result for RAG ingestion
	 */
	private summarizeActivity(activity: any): string {
		const name = activity.name || activity.title || "Activity";
		const city = activity.geoCode?.cityName || "";
		const price = activity.price?.amount || "";
		const category = activity.category || "";
		
		let summary = `${name}`;
		if (city) summary += ` in ${city}`;
		if (category) summary += ` (${category})`;
		if (price) summary += `, priced at ${price}`;
		
		return summary;
	}

	/**
	 * Determine if tools (Amadeus API) should be used
	 * Detects any travel-related query that might need API calls
	 */
	private shouldUseTools(message: string): boolean {
		const toolKeywords = [
			// Flight-related
			"flight", "flights", "airline", "airport", "departure", "arrival",
			// Hotel-related
			"hotel", "hotels", "accommodation", "accommodations", "stay", "lodging",
			// Activity-related
			"activity", "activities", "tour", "tours", "things to do", "attractions",
			// General travel
			"book", "booking", "search", "price", "cost", "availability", "options",
			// Location-related
			"destination", "route", "transfer", "car rental", "rental car",
			// Recommendations
			"recommend", "suggest", "find", "show me", "what are",
		];
		const lowerMessage = message.toLowerCase();
		return toolKeywords.some((keyword) => lowerMessage.includes(keyword));
	}

	/**
	 * Use LLM to determine which Amadeus API to call based on user intent
	 * Returns: { apiName: string, params: any } or null
	 */
	private async determineAmadeusAPICall(message: string): Promise<{ apiName: string; params: any } | null> {
		try {
			// Use LLM to analyze intent and determine which API to call
			const prompt = `Analyze this travel query and determine which Amadeus API to call. Available APIs:
- Flight APIs: searchFlightOffers, searchFlightDestinations, searchCheapestFlightDates, getMostTraveledDestinations, getMostBookedDestinations, getFlightStatus, getFlightAvailabilities, getSeatmap, getAirlineRoutes, getAirportRoutes, getAirportNearestRelevant, getFlightCheckinLinks, getAirportOnTimePerformance
- Hotel APIs: searchHotelOffers, searchHotelsByGeocode, searchHotelsByCity, searchHotelNameAutocomplete, getHotelRatings
- Activity APIs: searchActivities, getActivity
- Transfer APIs: searchTransfers
- Location APIs: searchLocations, searchCities, getRecommendedLocations
- Other: getBusiestPeriod, getBrandedFaresUpsell

User query: "${message}"

Current trip state:
- Destination: ${this.state.basics.destination || "not specified"}
- Dates: ${this.state.basics.startDate || "not specified"} to ${this.state.basics.endDate || "not specified"}
- Budget: ${this.state.basics.budget || "not specified"}

Respond with ONLY a JSON object: { "apiName": "api_name", "params": { ... } } or { "apiName": null } if no API call is needed.
Extract relevant parameters from the query and trip state.`;

			const response = await this.env.AI.run("@cf/meta/llama-3.1-8b-instruct-fp8", {
				messages: [
					{ role: "system", content: "You are a travel API routing assistant. Respond with only valid JSON." },
					{ role: "user", content: prompt },
				],
				max_tokens: 200,
			});

			// Parse LLM response
			let responseText = "";
			if (typeof response === "string") {
				responseText = response;
			} else if (response && typeof response === "object" && "response" in response) {
				responseText = String(response.response);
			} else {
				responseText = JSON.stringify(response);
			}

			// Extract JSON from response (might have markdown code blocks)
			const jsonMatch = responseText.match(/\{[\s\S]*\}/);
			if (!jsonMatch) {
				return null;
			}

			const parsed = JSON.parse(jsonMatch[0]);
			if (parsed.apiName && parsed.apiName !== "null") {
				return { apiName: parsed.apiName, params: parsed.params || {} };
			}

			return null;
		} catch (error) {
			console.error("Error determining API call:", error);
			return null;
		}
	}

	/**
	 * Use external tools (Amadeus API)
	 * Now uses LLM-based intent detection to route to any of the 30 Amadeus APIs
	 */
	private async useTools(message: string): Promise<string> {
		try {
			let toolResults: string[] = [];
			const city = this.state.basics.destination;

			// Use LLM to determine which API to call
			let apiCall = await this.determineAmadeusAPICall(message);
			
			// Fallback to keyword-based detection if LLM didn't determine an API
			if (!apiCall || !apiCall.apiName) {
				const lowerMessage = message.toLowerCase();
				
				// Quick keyword-based routing for most common queries
				if (lowerMessage.includes("flight") && (this.state.basics.destination || this.state.basics.startDate)) {
					apiCall = {
						apiName: "searchFlightOffers",
						params: {
							origin: this.state.basics.origin,
							destination: this.state.basics.destination,
							departureDate: this.state.basics.startDate,
							returnDate: this.state.basics.endDate,
						},
					};
				} else if ((lowerMessage.includes("hotel") || lowerMessage.includes("accommodation")) && this.state.basics.destination) {
					apiCall = {
						apiName: "searchHotelOffers",
						params: {
							cityCode: city,
							checkInDate: this.state.basics.startDate,
							checkOutDate: this.state.basics.endDate,
							adults: 2,
						},
					};
				} else if (lowerMessage.includes("activity") || lowerMessage.includes("tour") || lowerMessage.includes("things to do")) {
					apiCall = {
						apiName: "searchActivities",
						params: {
							latitude: 48.8566, // Default Paris - should be looked up from destination
							longitude: 2.3522,
							radius: 5,
							pageLimit: 10,
						},
					};
				} else {
					// No API call needed
					return "";
				}
			}

			if (apiCall && apiCall.apiName) {
				// Call the determined API
				const result = await this.callAmadeusAPI(apiCall.apiName, apiCall.params);

				if (result.success && result.data) {
					// Determine result type for ingestion
					let resultType = "general";
					if (apiCall.apiName.includes("Flight") || apiCall.apiName.includes("flight")) {
						resultType = "flight";
					} else if (apiCall.apiName.includes("Hotel") || apiCall.apiName.includes("hotel")) {
						resultType = "hotel";
					} else if (apiCall.apiName.includes("Activity") || apiCall.apiName.includes("activity")) {
						resultType = "activity";
					} else if (apiCall.apiName.includes("Transfer") || apiCall.apiName.includes("transfer")) {
						resultType = "transfer";
					} else if (apiCall.apiName.includes("Location") || apiCall.apiName.includes("location") || apiCall.apiName.includes("City") || apiCall.apiName.includes("city")) {
						resultType = "location";
					}

					// Extract results array (handle different response structures)
					let results: any[] = [];
					if (result.data.data && Array.isArray(result.data.data)) {
						results = result.data.data;
					} else if (Array.isArray(result.data)) {
						results = result.data;
					} else if (typeof result.data === "object") {
						// Single result object
						results = [result.data];
					}

					// Ingest top results into Vectorize (if applicable)
					if (results.length > 0 && ["flight", "hotel", "activity"].includes(resultType)) {
						for (const item of results.slice(0, 5)) {
							await this.ingestAmadeusResult(item, resultType, city);
						}
					}

					// Format result summary
					if (results.length > 0) {
						toolResults.push(`Found ${results.length} result(s) from ${apiCall.apiName}`);
					} else {
						toolResults.push(`API call to ${apiCall.apiName} succeeded but returned no results`);
					}
				} else {
					toolResults.push(`API call error (${apiCall.apiName}): ${result.error || "Failed to call API"}`);
				}
			}

			return toolResults.length > 0 
				? `[Tool Results: ${toolResults.join("; ")}]`
				: "";
		} catch (error) {
			console.error("Tool execution error:", error);
			return `[Tool Error: ${error instanceof Error ? error.message : "Unknown error"}]`;
		}
	}


	/**
	 * Generate LLM response with context and tool results
	 * Returns a ReadableStream for streaming token-by-token responses
	 */
	private async generateLLMResponse(
		userMessage: string,
		ragContext: string,
		toolResults: string,
	): Promise<ReadableStream> {
		console.log("[TravelAgent] generateLLMResponse: Starting");
		
		// Build system prompt
		const systemPrompt = `You are a helpful travel assistant. You help users plan trips, find flights, and discover destinations.

Current trip information:
- Destination: ${this.state.basics.destination || "Not specified"}
- Dates: ${this.state.basics.startDate || "Not specified"} to ${this.state.basics.endDate || "Not specified"}
- Budget: ${this.state.basics.budget ? `$${this.state.basics.budget}` : "Not specified"}
- Preferences: ${this.state.preferences.join(", ") || "None specified"}

${ragContext ? `\nRelevant context: ${ragContext}` : ""}
${toolResults ? `\nTool results: ${toolResults}` : ""}

Provide helpful, personalized travel advice based on the user's query and the information available.`;

		console.log("[TravelAgent] generateLLMResponse: System prompt length:", systemPrompt.length);

		// Build conversation history (last 5 messages for context)
		const recentHistory = this.state.recentMessages.slice(-5);
		const messages = [
			{ role: "system" as const, content: systemPrompt },
			...recentHistory.map((msg) => ({
				role: msg.role as "user" | "assistant",
				content: msg.content,
			})),
		];

		console.log("[TravelAgent] generateLLMResponse: Messages array length:", messages.length);
		console.log("[TravelAgent] generateLLMResponse: Calling AI.run with stream: true");

		// Call Workers AI with streaming enabled
		// Returns a ReadableStream in Server-Sent Events (SSE) format
		let stream: ReadableStream;
		try {
			const aiResponse = await this.env.AI.run(
				"@cf/meta/llama-3.1-8b-instruct-fp8",
				{
					messages,
					max_tokens: 1024,
					stream: true, // Enable streaming
				},
			);
			
			console.log("[TravelAgent] generateLLMResponse: AI.run returned, type:", typeof aiResponse, aiResponse?.constructor?.name);
			
			if (!aiResponse) {
				throw new Error("AI.run returned null or undefined");
			}
			
			if (!(aiResponse instanceof ReadableStream)) {
				console.error("[TravelAgent] generateLLMResponse: AI.run did not return ReadableStream, got:", typeof aiResponse);
				throw new Error(`AI.run did not return ReadableStream, got: ${typeof aiResponse}`);
			}
			
			stream = aiResponse as ReadableStream;
			console.log("[TravelAgent] generateLLMResponse: Stream obtained successfully");
		} catch (aiError) {
			console.error("[TravelAgent] generateLLMResponse: Error calling AI.run:", aiError);
			console.error("[TravelAgent] generateLLMResponse: AI.run error stack:", aiError instanceof Error ? aiError.stack : "No stack trace");
			throw aiError;
		}

		// Return the stream directly (Workers AI returns ReadableStream when stream: true)
		return stream;
	}
}

