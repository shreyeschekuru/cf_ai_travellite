/**
 * Think Tools - Amadeus and RAG tools for @cloudflare/think reasoning agent
 * These tools are registered with the Think agent for multi-turn reasoning
 */

import type { Env } from "./types";
import { AmadeusClient } from "./amadeus-client";

export interface ThinkToolInput {
  [key: string]: unknown;
}

export interface ThinkTool {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
  execute: (params: ThinkToolInput) => Promise<string>;
}

/**
 * Build Amadeus flight search tool for Think
 */
export function buildFlightSearchTool(amadeusClient: AmadeusClient): ThinkTool {
  return {
    name: "search_flights",
    description: "Search for flight offers between two locations. Returns available flights with prices and details.",
    inputSchema: {
      type: "object",
      properties: {
        origin: {
          type: "string",
          description: "Departure airport code (e.g., NYC, LAX, JFK)",
        },
        destination: {
          type: "string",
          description: "Arrival airport code (e.g., MIA, SFO, LHR)",
        },
        departureDate: {
          type: "string",
          description: "Departure date in YYYY-MM-DD format",
        },
        returnDate: {
          type: "string",
          description: "Return date for round-trip (optional, YYYY-MM-DD format)",
        },
        adults: {
          type: "number",
          description: "Number of adult passengers (default: 1)",
        },
      },
      required: ["origin", "destination", "departureDate"],
    },
    execute: async (params: ThinkToolInput): Promise<string> => {
      try {
        const result = await amadeusClient.searchFlightOffers({
          originLocationCode: String(params.origin),
          destinationLocationCode: String(params.destination),
          departureDate: String(params.departureDate),
          returnDate: params.returnDate ? String(params.returnDate) : undefined,
          adults: params.adults ? Number(params.adults) : 1,
        });

        if (!result || result.length === 0) {
          return "No flights found for the requested dates and route.";
        }

        // Format results for the agent
        const formatted = result
          .slice(0, 3) // Top 3 results
          .map((flight: any, i: number) => {
            const price = flight.price?.grandTotal || flight.price?.total || "N/A";
            const duration = flight.itineraries?.[0]?.duration || "N/A";
            return `${i + 1}. ${String(params.origin)}-${String(params.destination)} - Price: $${price}, Duration: ${duration}`;
          })
          .join("\n");

        return `Found ${result.length} flights:\n${formatted}`;
      } catch (error) {
        return `Error searching flights: ${error instanceof Error ? error.message : "Unknown error"}`;
      }
    },
  };
}

/**
 * Build hotel search tool for Think
 */
export function buildHotelSearchTool(amadeusClient: AmadeusClient): ThinkTool {
  return {
    name: "search_hotels",
    description: "Search for hotel accommodations in a city. Returns available hotels with prices and ratings.",
    inputSchema: {
      type: "object",
      properties: {
        city: {
          type: "string",
          description: "City code or name (e.g., PAR for Paris, NYC for New York)",
        },
        checkInDate: {
          type: "string",
          description: "Check-in date in YYYY-MM-DD format",
        },
        checkOutDate: {
          type: "string",
          description: "Check-out date in YYYY-MM-DD format",
        },
        adults: {
          type: "number",
          description: "Number of adults (default: 1)",
        },
      },
      required: ["city"],
    },
    execute: async (params: ThinkToolInput): Promise<string> => {
      try {
        const result = await amadeusClient.searchHotelOffers({
          cityCode: String(params.city),
          checkInDate: params.checkInDate ? String(params.checkInDate) : undefined,
          checkOutDate: params.checkOutDate ? String(params.checkOutDate) : undefined,
          adults: params.adults ? Number(params.adults) : 1,
        });

        if (!result || result.length === 0) {
          return "No hotels found for the requested criteria.";
        }

        // Format results
        const formatted = result
          .slice(0, 3)
          .map((hotel: any, i: number) => {
            const name = hotel.hotel?.name || "Hotel";
            const price = hotel.offers?.[0]?.price?.total || "N/A";
            const rating = hotel.hotel?.rating || "N/A";
            return `${i + 1}. ${name} - Price: $${price}/night, Rating: ${rating}⭐`;
          })
          .join("\n");

        return `Found ${result.length} hotels:\n${formatted}`;
      } catch (error) {
        return `Error searching hotels: ${error instanceof Error ? error.message : "Unknown error"}`;
      }
    },
  };
}

/**
 * Build activities search tool for Think
 */
export function buildActivitiesSearchTool(amadeusClient: AmadeusClient): ThinkTool {
  return {
    name: "search_activities",
    description: "Search for activities and attractions in a location. Returns available tours and experiences.",
    inputSchema: {
      type: "object",
      properties: {
        latitude: {
          type: "number",
          description: "Latitude of the location",
        },
        longitude: {
          type: "number",
          description: "Longitude of the location",
        },
        radius: {
          type: "number",
          description: "Search radius in kilometers (default: 15)",
        },
      },
      required: ["latitude", "longitude"],
    },
    execute: async (params: ThinkToolInput): Promise<string> => {
      try {
        const result = await amadeusClient.searchActivities({
          latitude: Number(params.latitude),
          longitude: Number(params.longitude),
          radius: params.radius ? Number(params.radius) : 15,
        });

        if (!result || result.length === 0) {
          return "No activities found in this area.";
        }

        // Format results
        const formatted = result
          .slice(0, 3)
          .map((activity: any, i: number) => {
            const name = activity.name || "Activity";
            const price = activity.price?.amount || "N/A";
            return `${i + 1}. ${name} - Price: $${price}`;
          })
          .join("\n");

        return `Found ${result.length} activities:\n${formatted}`;
      } catch (error) {
        return `Error searching activities: ${error instanceof Error ? error.message : "Unknown error"}`;
      }
    },
  };
}

/**
 * Build RAG search tool for Think
 */
export function buildRAGSearchTool(env: Env, destination?: string): ThinkTool {
  return {
    name: "search_destination_info",
    description: "Search for general information and recommendations about a travel destination.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "What information are you looking for about the destination?",
        },
        destination: {
          type: "string",
          description: "Destination city or country (optional, will use current trip destination if not provided)",
        },
      },
      required: ["query"],
    },
    execute: async (params: ThinkToolInput): Promise<string> => {
      try {
        const query = String(params.query);
        const dest = params.destination ? String(params.destination) : destination;

        // Generate embedding
        const response = await env.AI.run("@cf/baai/bge-base-en-v1.5", {
          text: [query],
        });

        let embedding: number[] = [];
        if (response && typeof response === "object" && "data" in response) {
          const data = (response as any).data;
          if (Array.isArray(data) && data.length > 0 && Array.isArray(data[0])) {
            embedding = data[0];
          } else if (Array.isArray(data)) {
            embedding = data;
          }
        }

        if (embedding.length === 0) {
          return "Could not generate embedding for search.";
        }

        // Query Vectorize
        const filter: Record<string, string> = {};
        if (dest) {
          filter.city = dest;
        }

        const result = await env.VECTORIZE.query(embedding, {
          topK: 3,
          filter: Object.keys(filter).length > 0 ? filter : undefined,
        });

        if (!result || !result.matches || result.matches.length === 0) {
          return "No information found for this query.";
        }

        // Format results
        const formatted = result.matches
          .map((match: any) => {
            const text = match.metadata?.text || "Information";
            const source = match.metadata?.source || "knowledge base";
            return `• ${text} (Source: ${source})`;
          })
          .join("\n");

        return `Information about ${dest || "the destination"}:\n${formatted}`;
      } catch (error) {
        return `Error searching destination info: ${error instanceof Error ? error.message : "Unknown error"}`;
      }
    },
  };
}

/**
 * Register all tools for a Think agent
 */
export function registerThinkTools(amadeusClient: AmadeusClient, env: Env, destination?: string): ThinkTool[] {
  return [
    buildFlightSearchTool(amadeusClient),
    buildHotelSearchTool(amadeusClient),
    buildActivitiesSearchTool(amadeusClient),
    buildRAGSearchTool(env, destination),
  ];
}
