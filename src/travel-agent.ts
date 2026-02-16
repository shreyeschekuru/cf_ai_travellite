import { Agent, callable, type Connection } from "agents";
import {
	Env,
	type GatewayMessage,
	type GatewayResponse,
	isGatewayMessage,
} from "./types";
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
					// Find the callable method
					const method = (this as any)[rpcData.method];
					if (method && typeof method === "function") {
						try {
							// Call the method with the provided arguments
							const result = await method.apply(this, rpcData.args);

							// Return RPC response
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
	 * Handle incoming WebSocket messages from clients
	 * Processes messages and sends responses back through the WebSocket connection
	 * @param connection The connection that sent the message
	 * @param message The message payload (typically a JSON string)
	 */
	async onMessage(connection: Connection, message: unknown) {
		try {
			// Parse the incoming message
			let messageData: GatewayMessage;
			
			if (typeof message === "string") {
				try {
					const parsed = JSON.parse(message);
					if (isGatewayMessage(parsed)) {
						messageData = parsed;
					} else {
						// If not a GatewayMessage, treat the entire string as the message text
						messageData = { type: "message", text: message };
					}
				} catch {
					// If not JSON, treat the entire string as the message text
					messageData = { type: "message", text: message };
				}
			} else if (isGatewayMessage(message)) {
				messageData = message;
			} else {
				// Invalid message format
				const errorResponse: GatewayResponse = {
					type: "response",
					error: "Invalid message format",
				};
				connection.send(JSON.stringify(errorResponse));
				return;
			}

			// Extract message text
			const text = messageData.text?.trim() || "";
			
			if (!text) {
				const errorResponse: GatewayResponse = {
					type: "response",
					error: "Message text is required",
				};
				connection.send(JSON.stringify(errorResponse));
				return;
			}

			// Process the message through the agent's handleMessage method
			// This will handle RAG, tools, and LLM generation
			const response = await this.handleMessage(text);

			// Send response back through WebSocket connection
			const successResponse: GatewayResponse = {
				type: "response",
				text: response,
				userId: messageData.userId,
				timestamp: Date.now(),
			};
			connection.send(JSON.stringify(successResponse));
		} catch (error) {
			console.error("Error processing WebSocket message:", error);
			
			// Send error response back to client
			const errorResponse: GatewayResponse = {
				type: "response",
				error: error instanceof Error ? error.message : "Failed to process message",
				timestamp: Date.now(),
			};
			connection.send(JSON.stringify(errorResponse));
		}
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
	 * @returns Response string from the agent
	 */
	@callable({ description: "Handle user message with RAG, tools, and LLM" })
	async handleMessage(input: string): Promise<string> {
		// 1. Update state with user message
		this.setState({
			...this.state,
			recentMessages: [
				...this.state.recentMessages,
				{ role: "user", content: input },
			],
		});

		// 2. Extract and update trip basics from message
		this.extractTripInfo(input);

		// 3. Decide on routing: RAG + Tools + LLM
		let context = "";
		let toolResults = "";

		// Check if we need RAG (Vectorize search)
		const needsRAG = this.shouldUseRAG(input);
		if (needsRAG) {
			context = await this.performRAG(input);
		}

		// Check if we need tools (Amadeus API)
		const needsTools = this.shouldUseTools(input);
		if (needsTools) {
			toolResults = await this.useTools(input);
		}

		// 4. Generate LLM response with context and tool results
		const response = await this.generateLLMResponse(
			input,
			context,
			toolResults,
		);

		// 5. Update state with assistant response
		this.setState({
			...this.state,
			recentMessages: [
				...this.state.recentMessages,
				{ role: "assistant", content: response },
			],
		});

		return response;
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
	 */
	private shouldUseTools(message: string): boolean {
		const toolKeywords = [
			"flight",
			"flights",
			"book",
			"search",
			"price",
			"cost",
			"airline",
			"hotel",
			"accommodation",
		];
		const lowerMessage = message.toLowerCase();
		return toolKeywords.some((keyword) => lowerMessage.includes(keyword));
	}

	/**
	 * Use external tools (Amadeus API)
	 */
	private async useTools(message: string): Promise<string> {
		try {
			const lowerMessage = message.toLowerCase();
			let toolResults: string[] = [];
			const city = this.state.basics.destination;

			// Check if user is asking about flights
			if (lowerMessage.includes("flight")) {
				if (
					this.state.basics.destination &&
					this.state.basics.startDate
				) {
					// Call callAmadeusAPI to search for flight offers
					const result = await this.callAmadeusAPI("searchFlightOffers", {
						origin: "NYC", // Default or extract from message
						destination: this.state.basics.destination,
						departureDate: this.state.basics.startDate,
						returnDate: this.state.basics.endDate,
					});

					if (result.success && result.data) {
						const flights = result.data.data || [];
						
						// Ingest top results into Vectorize
						for (const flight of flights.slice(0, 5)) {
							await this.ingestAmadeusResult(flight, "flight", city);
						}
						
						toolResults.push(`Found ${flights.length} flight options`);
					} else {
						toolResults.push(`Flight search error: ${result.error || "Failed to search flights"}`);
					}
				}
			}

			// Check if user is asking about hotels
			if (lowerMessage.includes("hotel") || lowerMessage.includes("accommodation")) {
				if (this.state.basics.destination) {
					const result = await this.callAmadeusAPI("searchHotelOffers", {
						cityCode: city,
						checkInDate: this.state.basics.startDate,
						checkOutDate: this.state.basics.endDate,
						adults: 2,
					});

					if (result.success && result.data) {
						const hotels = result.data.data || [];
						
						// Ingest top results into Vectorize
						for (const hotel of hotels.slice(0, 5)) {
							await this.ingestAmadeusResult(hotel, "hotel", city);
						}
						
						toolResults.push(`Found ${hotels.length} hotel options`);
					} else {
						toolResults.push(`Hotel search error: ${result.error || "Failed to search hotels"}`);
					}
				}
			}

			// Check if user is asking about activities
			if (lowerMessage.includes("activity") || lowerMessage.includes("tour") || lowerMessage.includes("things to do")) {
				// Try to get coordinates for the destination (simplified - would need location lookup)
				const result = await this.callAmadeusAPI("searchActivities", {
					latitude: 48.8566, // Default Paris - should be looked up from destination
					longitude: 2.3522,
					radius: 5,
					pageLimit: 10,
				});

				if (result.success && result.data) {
					const activities = result.data.data || [];
					
					// Ingest top results into Vectorize
					for (const activity of activities.slice(0, 5)) {
						await this.ingestAmadeusResult(activity, "activity", city);
					}
					
					toolResults.push(`Found ${activities.length} activity options`);
				} else {
					toolResults.push(`Activity search error: ${result.error || "Failed to search activities"}`);
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
	 */
	private async generateLLMResponse(
		userMessage: string,
		ragContext: string,
		toolResults: string,
	): Promise<string> {
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

		// Build conversation history (last 5 messages for context)
		const recentHistory = this.state.recentMessages.slice(-5);
		const messages = [
			{ role: "system" as const, content: systemPrompt },
			...recentHistory.map((msg) => ({
				role: msg.role as "user" | "assistant",
				content: msg.content,
			})),
		];

		// Call Workers AI
		const response = await this.env.AI.run(
			"@cf/meta/llama-3.1-8b-instruct-fp8",
			{
				messages,
				max_tokens: 1024,
			},
		);

		// Extract response text (adjust based on actual response format)
		if (typeof response === "string") {
			return response;
		} else if (response && typeof response === "object" && "response" in response) {
			return String(response.response);
		} else {
			return JSON.stringify(response);
		}
	}
}

