import { Agent, callable } from "agents";
import { Env } from "./types";
import { AmadeusClient } from "./amadeus-client";

/**
 * Basic trip information
 */
export type TripBasics = {
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
}

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
	};

	/**
	 * Amadeus API client instance (lazy initialization)
	 */
	private _amadeusClient: AmadeusClient | null = null;

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
		// Initialize agent state if needed
		// State is already initialized with initialState
	}

	/**
	 * Handle HTTP requests (including RPC requests)
	 * Implements RPC handling for @callable methods
	 */
	async onRequest(request: Request): Promise<Response> {
		// Check if this is an RPC request
		if (request.method === "POST") {
			try {
				const rpcData = (await request.json()) as {
					type: string;
					id: string;
					method: string;
					args: unknown[];
				};

				if (rpcData.type === "rpc" && rpcData.method) {
					console.log("[TravelAgent] RPC call received:", rpcData.method, "with args:", rpcData.args);
					// Find the callable method
					const method = (this as any)[rpcData.method];
					if (method && typeof method === "function") {
						console.log("[TravelAgent] Method found, calling...");
						try {
							// Call the method with the provided arguments
							const result = await method.apply(this, rpcData.args);
							console.log("[TravelAgent] Method call completed, result type:", typeof result);

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

		// For non-RPC requests, return 404
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
		let accumulatedText = "";
		let chunkCount = 0;

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
							accumulatedText += finalChunk;
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

					// Publish final complete response
					await stub.fetch(
						new Request("https://realtime-connector/publish", {
							method: "POST",
							headers: { "Content-Type": "application/json" },
							body: JSON.stringify({
								room: roomId,
								message: {
									type: "agent_response",
									text: accumulatedText,
									userId: userId,
									timestamp: Date.now(),
									complete: true,
								},
							}),
						}),
					);
					console.log(`[TravelAgent] streamToRealtime: Stream complete. Total chunks: ${chunkCount}, Total length: ${accumulatedText.length}`);
					break;
				}

				// Decode chunk (plain text, not SSE)
				const chunk = decoder.decode(value, { stream: true });
				
				// Only send non-empty chunks
				if (chunk && chunk.trim().length > 0) {
					accumulatedText += chunk;
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
	 */
	private async accumulateStream(stream: ReadableStream): Promise<string> {
		const reader = stream.getReader();
		const decoder = new TextDecoder();
		let buffer = "";
		let accumulatedText = "";

		try {
			while (true) {
				const { done, value } = await reader.read();

				if (done) {
					// Process any remaining buffer
					if (buffer) {
						const parsed = this.parseSSEChunk(buffer);
						for (const content of parsed.contents) {
							accumulatedText += content;
						}
					}
					break;
				}

				// Decode chunk and process SSE events
				buffer += decoder.decode(value, { stream: true });
				const parsed = this.parseSSEChunk(buffer);
				buffer = parsed.buffer;

				// Accumulate each content chunk
				for (const content of parsed.contents) {
					accumulatedText += content;
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


	/**
	 * Main message handler that orchestrates RAG, tools, and LLM
	 * @param input User's message input
	 * @returns ReadableStream for streaming token-by-token responses
	 */
	/**
	 * Handle message with streaming via Realtime
	 * Streams chunks progressively to Realtime room via RealtimeConnector
	 * @param input User's message input
	 * @param roomId Realtime room ID to publish to
	 * @param userId User ID
	 * @returns Promise that resolves when streaming is complete
	 */
	@callable({ description: "Handle user message with RAG, tools, and LLM, streaming to Realtime" })
	async handleMessageStreaming(
		input: string,
		roomId: string,
		userId?: string,
	): Promise<{ success: boolean; message?: string; error?: string }> {
		console.log("[TravelAgent] handleMessageStreaming: Starting");
		
		try {
			// Get the stream from handleMessage
			const stream = await this.handleMessage(input);
			
			// Stream chunks to Realtime via RealtimeConnector
			await this.streamToRealtime(stream, roomId, userId);
			
			return { success: true, message: "Streaming completed" };
		} catch (error) {
			console.error("[TravelAgent] handleMessageStreaming: Error:", error);
			return {
				success: false,
				error: error instanceof Error ? error.message : "Failed to process message",
			};
		}
	}

	@callable({ description: "Handle user message with RAG, tools, and LLM" })
	async handleMessage(input: string): Promise<ReadableStream> {
		console.log("[TravelAgent] handleMessage: Starting, input:", input.substring(0, 50));
		
		// 1. Update state with user message
		console.log("[TravelAgent] handleMessage: Step 1 - Updating state");
		this.setState({
			...this.state,
			recentMessages: [
				...this.state.recentMessages,
				{ role: "user" as const, content: input },
			],
		});

		// 2. Extract and update trip basics from message
		console.log("[TravelAgent] handleMessage: Step 2 - Extracting trip info");
		this.extractTripInfo(input);

		// 3. Decide on routing: RAG + Tools + LLM
		let context = "";
		let toolResults = "";

		// Check if we need RAG (Vectorize search)
		console.log("[TravelAgent] handleMessage: Step 3a - Checking if RAG needed");
		const needsRAG = this.shouldUseRAG(input);
		console.log("[TravelAgent] handleMessage: RAG needed:", needsRAG);
		if (needsRAG) {
			console.log("[TravelAgent] handleMessage: Performing RAG search");
			context = await this.performRAG(input);
			console.log("[TravelAgent] handleMessage: RAG context length:", context.length);
		}

		// Check if we need tools (Amadeus API)
		console.log("[TravelAgent] handleMessage: Step 3b - Checking if tools needed");
		const needsTools = this.shouldUseTools(input);
		console.log("[TravelAgent] handleMessage: Tools needed:", needsTools);
		if (needsTools) {
			console.log("[TravelAgent] handleMessage: Calling tools");
			toolResults = await this.useTools(input);
			console.log("[TravelAgent] handleMessage: Tool results length:", toolResults.length);
		}

		// 4. Generate LLM response stream with context and tool results
		console.log("[TravelAgent] handleMessage: Step 4 - Generating LLM response");
		let stream: ReadableStream;
		try {
			stream = await this.generateLLMResponse(
				input,
				context,
				toolResults,
			);
			console.log("[TravelAgent] handleMessage: Got stream from generateLLMResponse, type:", stream?.constructor?.name);
		} catch (llmError) {
			console.error("[TravelAgent] handleMessage: Error in generateLLMResponse:", llmError);
			console.error("[TravelAgent] handleMessage: generateLLMResponse error stack:", llmError instanceof Error ? llmError.stack : "No stack trace");
			throw llmError;
		}

		// 5. Create a transformed stream that accumulates the full response for state
		// This allows us to stream to the client while also storing the complete response
		console.log("[TravelAgent] handleMessage: Step 5 - Transforming stream for state");
		try {
			const transformedStream = this.transformStreamForState(stream, input);
			console.log("[TravelAgent] handleMessage: Stream transformed successfully");
			return transformedStream;
		} catch (transformError) {
			console.error("[TravelAgent] handleMessage: Error in transformStreamForState:", transformError);
			console.error("[TravelAgent] handleMessage: transformStreamForState error stack:", transformError instanceof Error ? transformError.stack : "No stack trace");
			throw transformError;
		}
	}

	/**
	 * Extract trip information from user message and update state
	 */
	private extractTripInfo(message: string): void {
		const lowerMessage = message.toLowerCase();
		const updates: Partial<TravelState> = {};

		// Extract destination
		const destinationMatch = message.match(
			/(?:going to|visit|travel to|destination|trip to)\s+([A-Z][a-zA-Z\s]+)/i,
		);
		if (destinationMatch && !this.state.basics.destination) {
			updates.basics = {
				...this.state.basics,
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
				if (lowerMessage.includes("flight") && this.state.basics.destination && this.state.basics.startDate) {
					apiCall = {
						apiName: "searchFlightOffers",
						params: {
							origin: "NYC", // Default or extract from message
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

