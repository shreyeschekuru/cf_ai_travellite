import { Agent, callable, type Connection } from "agents";
import { Env } from "./types";

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
	 * Handle incoming messages from clients
	 * @param connection The connection that sent the message
	 * @param message The message payload
	 */
	async onMessage(connection: Connection, message: unknown) {
		// Handle message processing here
		// You can add custom logic for processing travel-related queries
		// Messages can be added to recentMessages as needed
	}

	/**
	 * Example method to search for flights using Amadeus API
	 * Marked as callable so clients can invoke it
	 */
	@callable({ description: "Search for flights using Amadeus API" })
	async searchFlights(params: {
		origin: string;
		destination: string;
		departureDate: string;
		returnDate?: string;
		adults?: number;
	}) {
		// Access Amadeus API credentials from env
		const apiKey = this.env.AMADEUS_API_KEY;
		const apiSecret = this.env.AMADEUS_API_SECRET;

		// TODO: Implement Amadeus API flight search
		// This is a placeholder - you'll need to implement the actual API call

		return {
			success: true,
			message: "Flight search functionality to be implemented",
			params,
		};
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
	 * Perform RAG search using Vectorize
	 */
	private async performRAG(query: string): Promise<string> {
		try {
			// Generate embedding for the query (simplified - you'd use Workers AI embedding model)
			// For now, we'll use a simple keyword-based approach
			// In production, you'd generate embeddings and search Vectorize

			// Example: Query Vectorize index
			// const embedding = await this.generateEmbedding(query);
			// const results = await this.env.VECTORIZE.query(embedding, { topK: 5 });

			// For now, return a placeholder
			// You would query your Vectorize index with travel knowledge here
			return `[RAG Context: Found relevant travel information about ${this.state.basics.destination || "the destination"}]`;
		} catch (error) {
			console.error("RAG search error:", error);
			return "";
		}
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

			// Check if user is asking about flights
			if (lowerMessage.includes("flight")) {
				if (
					this.state.basics.destination &&
					this.state.basics.startDate
				) {
					// Call Amadeus API for flight search
					const flightResults = await this.searchFlightsViaAmadeus({
						origin: "NYC", // Default or extract from message
						destination: this.state.basics.destination,
						departureDate: this.state.basics.startDate,
						returnDate: this.state.basics.endDate,
					});

					return `[Tool Results: Found ${flightResults.length} flight options]`;
				}
			}

			// Add more tool calls as needed (hotels, etc.)
			return "";
		} catch (error) {
			console.error("Tool execution error:", error);
			return `[Tool Error: ${error instanceof Error ? error.message : "Unknown error"}]`;
		}
	}

	/**
	 * Search flights via Amadeus API using GET
	 */
	private async searchFlightsViaAmadeus(params: {
		origin: string;
		destination: string;
		departureDate: string;
		returnDate?: string;
	}): Promise<any[]> {
		// Get Amadeus access token first
		const accessToken = await this.getAmadeusAccessToken();

		// Build flight search URL with query parameters
		const baseUrl = "https://test.api.amadeus.com/v2/shopping/flight-offers";
		
		const searchParams = new URLSearchParams({
			originLocationCode: params.origin,
			destinationLocationCode: params.destination,
			departureDate: params.departureDate,
			adults: "1",
			max: "5",
		});

		if (params.returnDate) {
			searchParams.append("returnDate", params.returnDate);
		}

		// Use GET with query parameters
		const response = await fetch(`${baseUrl}?${searchParams}`, {
			method: "GET",
			headers: {
				Authorization: `Bearer ${accessToken}`,
			},
		});

		if (!response.ok) {
			const errorText = await response.text();
			throw new Error(
				`Amadeus API error: ${response.statusText} - ${errorText}`,
			);
		}

		const data = (await response.json()) as { data?: any[] };
		return data.data || [];
	}

	/**
	 * Get Amadeus API access token
	 */
	private async getAmadeusAccessToken(): Promise<string> {
		const response = await fetch(
			"https://test.api.amadeus.com/v1/security/oauth2/token",
			{
				method: "POST",
				headers: {
					"Content-Type": "application/x-www-form-urlencoded",
				},
				body: new URLSearchParams({
					grant_type: "client_credentials",
					client_id: this.env.AMADEUS_API_KEY,
					client_secret: this.env.AMADEUS_API_SECRET,
				}),
			},
		);

		if (!response.ok) {
			throw new Error("Failed to get Amadeus access token");
		}

		const data = (await response.json()) as { access_token: string };
		return data.access_token;
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

