import { Agent, callable, type Connection } from "agents";
import { Env } from "./types";

/**
 * State interface for the Travel Agent
 */
export interface TravelState {
	/**
	 * Current conversation context
	 */
	conversation?: {
		messages: Array<{
			role: "user" | "assistant" | "system";
			content: string;
		}>;
	};

	/**
	 * User's travel preferences
	 */
	preferences?: {
		destination?: string;
		dates?: {
			departure: string;
			return: string;
		};
		budget?: number;
		travelers?: number;
	};

	/**
	 * Current search or booking context
	 */
	currentSearch?: {
		flights?: unknown[];
		hotels?: unknown[];
		selectedFlight?: unknown;
		selectedHotel?: unknown;
	};

	/**
	 * Session metadata
	 */
	session?: {
		userId?: string;
		createdAt?: number;
		lastActivity?: number;
	};
}

/**
 * Travel Agent class that extends Agent for travel-related tasks
 */
export class TravelAgent extends Agent<Env, TravelState> {
	/**
	 * Initial state for the Travel Agent
	 */
	initialState: TravelState = {
		conversation: {
			messages: [],
		},
	};

	/**
	 * Called when the agent is first created or restarted
	 */
	async onStart() {
		// Initialize agent state if needed
		if (!this.state.session) {
			this.setState({
				...this.state,
				session: {
					createdAt: Date.now(),
					lastActivity: Date.now(),
				},
			});
		}
	}

	/**
	 * Handle incoming messages from clients
	 * @param connection The connection that sent the message
	 * @param message The message payload
	 */
	async onMessage(connection: Connection, message: unknown) {
		// Update last activity
		this.setState({
			...this.state,
			session: {
				...this.state.session,
				lastActivity: Date.now(),
			},
		});

		// Handle message processing here
		// You can add custom logic for processing travel-related queries
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
	 * Example method to get travel recommendations
	 */
	@callable({ description: "Get AI-powered travel recommendations" })
	async getRecommendations(query: string) {
		// Use Workers AI to generate travel recommendations
		const response = await this.env.AI.run(
			"@cf/meta/llama-3.1-8b-instruct-fp8",
			{
				messages: [
					{
						role: "system",
						content:
							"You are a helpful travel assistant. Provide personalized travel recommendations based on user queries.",
					},
					{
						role: "user",
						content: query,
					},
				],
				max_tokens: 1024,
			},
		);

		return {
			recommendations: response,
		};
	}
}

