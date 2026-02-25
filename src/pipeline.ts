/**
 * Worker-side pipeline: RAG + Amadeus tools + LLM generation.
 * Runs in the Worker to avoid Durable Object CPU limits; DO is used only to forward/publish chunks.
 */

import type { Env } from "./types";
import { AmadeusClient } from "./amadeus-client";

const EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5";
const LLM_MODEL = "@cf/meta/llama-3.1-8b-instruct-fp8";

const RAG_TIMEOUT_MS = 5_000;
const TOOLS_TIMEOUT_MS = 10_000;

export interface PipelineTripState {
	basics?: { destination?: string; startDate?: string; endDate?: string; budget?: number };
	preferences?: string[];
	/** Last N messages for LLM context (user/assistant). Capped when stored. */
	recentMessages?: Array<{ role: "user" | "assistant"; content: string }>;
}

const defaultTripState: PipelineTripState = {
	basics: {},
	preferences: [],
};

function shouldUseRAG(message: string): boolean {
	const lower = message.toLowerCase();
	const ragKeywords = [
		"recommend",
		"suggest",
		"what to do",
		"attractions",
		"places to visit",
		"activities",
		"things to see",
		"itinerary",
		"plan a trip",
		"plan my trip",
		"trip to ",
	];
	return ragKeywords.some((k) => lower.includes(k));
}

function shouldUseTools(message: string): boolean {
	const lower = message.toLowerCase();
	const toolKeywords = [
		"flight", "flights", "airline", "airport", "departure", "arrival",
		"hotel", "hotels", "accommodation", "stay", "lodging",
		"activity", "activities", "tour", "tours", "things to do", "attractions",
		"book", "booking", "search", "price", "cost", "availability", "options",
		"destination", "route", "transfer", "car rental", "rental car",
		"recommend", "suggest", "find", "show me", "what are",
		"plan a trip", "trip to ", "weekend trip", "3-day trip", "budget",
	];
	return toolKeywords.some((k) => lower.includes(k));
}

async function generateEmbedding(env: Env, text: string): Promise<number[]> {
	const response = await env.AI.run(EMBEDDING_MODEL, { text: [text] });
	if (response && typeof response === "object" && "data" in response) {
		const data = (response as { data: unknown }).data;
		if (Array.isArray(data) && data.length > 0 && Array.isArray(data[0])) return data[0] as number[];
		if (Array.isArray(data)) return data as number[];
	}
	throw new Error("Unexpected embedding response format");
}

export async function performRAG(
	env: Env,
	query: string,
	destination?: string,
): Promise<string> {
	try {
		console.log("[Pipeline RAG] Querying Vectorize, destination:", destination ?? "any");
		const queryEmbedding = await generateEmbedding(env, query);
		const filter: Record<string, string> = {};
		if (destination) filter.city = destination;
		const queryResult = await env.VECTORIZE.query(queryEmbedding, {
			topK: 5,
			filter: Object.keys(filter).length > 0 ? filter : undefined,
		});
		const matchCount = queryResult?.matches?.length ?? 0;
		console.log("[Pipeline RAG] Vectorize matches:", matchCount);
		if (!queryResult?.matches?.length) return "";
		const contextParagraphs = queryResult.matches
			.map((match: { metadata?: Record<string, unknown>; score?: number }, i: number) => {
				const meta = match.metadata || {};
				const source = (meta.source as string) || "travel knowledge base";
				const type = (meta.type as string) || "general";
				const topic = (meta.topic as string) || "";
				const text = (meta.text as string) || "";
				const contextText = text || (topic ? `Information about ${topic} (${type})` : `Travel information (${type})`);
				return `[${i + 1}] ${contextText} (Source: ${source}, Score: ${match.score?.toFixed(3) ?? "N/A"})`;
			})
			.join("\n\n");
		return contextParagraphs;
	} catch (e) {
		console.error("Pipeline RAG error:", e);
		return "";
	}
}

async function determineAmadeusAPICall(
	env: Env,
	message: string,
	tripState: PipelineTripState,
): Promise<{ apiName: string; params: Record<string, unknown> } | null> {
	try {
		const basics = tripState.basics || {};
		const prompt = `Analyze this travel query and determine which Amadeus API to call. Available APIs:
- Flight APIs: searchFlightOffers, searchFlightDestinations, searchCheapestFlightDates, getMostTraveledDestinations, getMostBookedDestinations, getFlightStatus, getFlightAvailabilities, getSeatmap, getAirlineRoutes, getAirportRoutes, getAirportNearestRelevant, getFlightCheckinLinks, getAirportOnTimePerformance
- Hotel APIs: searchHotelOffers, searchHotelsByGeocode, searchHotelsByCity, searchHotelNameAutocomplete, getHotelRatings
- Activity APIs: searchActivities, getActivity
- Transfer APIs: searchTransfers
- Location APIs: searchLocations, searchCities, getRecommendedLocations
- Other: getBusiestPeriod, getBrandedFaresUpsell

User query: "${message}"

Current trip state:
- Destination: ${basics.destination ?? "not specified"}
- Dates: ${basics.startDate ?? "not specified"} to ${basics.endDate ?? "not specified"}
- Budget: ${basics.budget ?? "not specified"}

Respond with ONLY a JSON object: { "apiName": "api_name", "params": { ... } } or { "apiName": null } if no API call is needed.`;

		const response = await env.AI.run(LLM_MODEL, {
			messages: [
				{ role: "system", content: "You are a travel API routing assistant. Respond with only valid JSON." },
				{ role: "user", content: prompt },
			],
			max_tokens: 200,
		});
		let responseText = "";
		if (typeof response === "string") responseText = response;
		else if (response && typeof response === "object" && "response" in response) responseText = String((response as { response: unknown }).response);
		else responseText = JSON.stringify(response);
		const jsonMatch = responseText.match(/\{[\s\S]*\}/);
		if (!jsonMatch) return null;
		const parsed = JSON.parse(jsonMatch[0]) as { apiName?: string | null; params?: Record<string, unknown> };
		if (parsed.apiName && parsed.apiName !== "null") return { apiName: parsed.apiName, params: parsed.params || {} };
		return null;
	} catch (e) {
		console.error("Pipeline determineAmadeusAPICall error:", e);
		return null;
	}
}

function summarizeHotel(hotel: Record<string, unknown>): string {
	const name = (hotel.name ?? hotel.hotelName ?? "Hotel") as string;
	const city = ((hotel.address as Record<string, unknown>)?.cityName ?? hotel.cityCode ?? "") as string;
	const price = (hotel.price as Record<string, unknown>)?.total ?? (hotel.price as Record<string, unknown>)?.base ?? hotel.price ?? "";
	const rating = (hotel.rating ?? hotel.starRating ?? "") as string;
	const amenities = (hotel.amenities as string[]) || [];
	let summary = `${name}`;
	if (city) summary += ` in ${city}`;
	if (rating) summary += ` (${rating}-star)`;
	if (price) summary += `, typically ${price}`;
	if (amenities.length > 0) summary += `. Features: ${amenities.slice(0, 3).join(", ")}`;
	return summary;
}

function summarizeFlight(flight: Record<string, unknown>): string {
	const origin = ((flight.origin as Record<string, unknown>)?.iataCode ?? flight.originLocationCode ?? "") as string;
	const dest = ((flight.destination as Record<string, unknown>)?.iataCode ?? flight.destinationLocationCode ?? "") as string;
	const price = (flight.price as Record<string, unknown>)?.total ?? (flight.price as Record<string, unknown>)?.grandTotal ?? flight.price ?? "";
	const duration = (flight.duration ?? "") as string;
	const stops = flight.numberOfBookableSeats !== undefined ? "non-stop" : "with stops";
	let summary = `Flight from ${origin} to ${dest}`;
	if (price) summary += ` for ${price}`;
	if (duration) summary += `, duration ${duration}`;
	summary += ` (${stops})`;
	return summary;
}

function summarizeActivity(activity: Record<string, unknown>): string {
	const name = (activity.name ?? activity.title ?? "Activity") as string;
	const city = ((activity.geoCode as Record<string, unknown>)?.cityName ?? "") as string;
	const price = (activity.price as Record<string, unknown>)?.amount ?? activity.price ?? "";
	const category = (activity.category ?? "") as string;
	let summary = `${name}`;
	if (city) summary += ` in ${city}`;
	if (category) summary += ` (${category})`;
	if (price) summary += `, priced at ${price}`;
	return summary;
}

async function callAmadeusAPI(
	client: AmadeusClient,
	apiName: string,
	params?: Record<string, unknown>,
): Promise<{ success: boolean; data?: unknown; error?: string }> {
	try {
		let result: unknown;
		switch (apiName) {
			case "searchFlightOffers":
				result = await client.searchFlightOffers({
					originLocationCode: (params?.origin ?? params?.originLocationCode) as string,
					destinationLocationCode: (params?.destination ?? params?.destinationLocationCode) as string,
					departureDate: params?.departureDate as string,
					returnDate: params?.returnDate as string,
					adults: params?.adults as number,
					children: params?.children as number,
					infants: params?.infants as number,
					travelClass: params?.travelClass as string,
					nonStop: params?.nonStop as boolean,
					max: params?.max as number,
				});
				break;
			case "getFlightOfferPrice":
				result = await client.getFlightOfferPrice((params?.flightOffer ?? params) as Parameters<AmadeusClient["getFlightOfferPrice"]>[0]);
				break;
			case "searchFlightDestinations":
				result = await client.searchFlightDestinations(params as Parameters<AmadeusClient["searchFlightDestinations"]>[0]);
				break;
			case "searchCheapestFlightDates":
				result = await client.searchCheapestFlightDates(params as Parameters<AmadeusClient["searchCheapestFlightDates"]>[0]);
				break;
			case "getMostTraveledDestinations":
				result = await client.getMostTraveledDestinations(params as Parameters<AmadeusClient["getMostTraveledDestinations"]>[0]);
				break;
			case "getMostBookedDestinations":
				result = await client.getMostBookedDestinations(params as Parameters<AmadeusClient["getMostBookedDestinations"]>[0]);
				break;
			case "getBusiestPeriod":
				result = await client.getBusiestPeriod(params as Parameters<AmadeusClient["getBusiestPeriod"]>[0]);
				break;
			case "getFlightAvailabilities":
				result = await client.getFlightAvailabilities(params as Parameters<AmadeusClient["getFlightAvailabilities"]>[0]);
				break;
			case "getSeatmap":
				result = await client.getSeatmap((params?.flightOffer ?? params) as Parameters<AmadeusClient["getSeatmap"]>[0]);
				break;
			case "getFlightStatus":
				result = await client.getFlightStatus(params as Parameters<AmadeusClient["getFlightStatus"]>[0]);
				break;
			case "searchAirlines":
				result = await client.searchAirlines(params as Parameters<AmadeusClient["searchAirlines"]>[0]);
				break;
			case "getAirlineRoutes":
				result = await client.getAirlineRoutes(params as Parameters<AmadeusClient["getAirlineRoutes"]>[0]);
				break;
			case "searchLocations":
				result = await client.searchLocations(params as Parameters<AmadeusClient["searchLocations"]>[0]);
				break;
			case "getAirportNearestRelevant":
				result = await client.getAirportNearestRelevant(params as Parameters<AmadeusClient["getAirportNearestRelevant"]>[0]);
				break;
			case "getAirportRoutes":
				result = await client.getAirportRoutes(params as Parameters<AmadeusClient["getAirportRoutes"]>[0]);
				break;
			case "getBrandedFaresUpsell":
				result = await client.getBrandedFaresUpsell({ flightOffer: (params?.flightOffer ?? params) as Parameters<AmadeusClient["getBrandedFaresUpsell"]>[0]["flightOffer"] });
				break;
			case "getFlightCheckinLinks":
				result = await client.getFlightCheckinLinks(params as Parameters<AmadeusClient["getFlightCheckinLinks"]>[0]);
				break;
			case "getAirportOnTimePerformance":
				result = await client.getAirportOnTimePerformance(params as Parameters<AmadeusClient["getAirportOnTimePerformance"]>[0]);
				break;
			case "searchCities":
				result = await client.searchCities(params as Parameters<AmadeusClient["searchCities"]>[0]);
				break;
			case "searchHotelsByGeocode":
				result = await client.searchHotelsByGeocode(params as Parameters<AmadeusClient["searchHotelsByGeocode"]>[0]);
				break;
			case "searchHotelsByCity":
				result = await client.searchHotelsByCity(params as Parameters<AmadeusClient["searchHotelsByCity"]>[0]);
				break;
			case "searchHotelOffers":
				result = await client.searchHotelOffers(params as Parameters<AmadeusClient["searchHotelOffers"]>[0]);
				break;
			case "searchHotelNameAutocomplete":
				result = await client.searchHotelNameAutocomplete(params as Parameters<AmadeusClient["searchHotelNameAutocomplete"]>[0]);
				break;
			case "getHotelRatings":
				result = await client.getHotelRatings(params as Parameters<AmadeusClient["getHotelRatings"]>[0]);
				break;
			case "searchActivities":
				result = await client.searchActivities(params as Parameters<AmadeusClient["searchActivities"]>[0]);
				break;
			case "getActivity":
				result = await client.getActivity((params?.activityId ?? params) as string, params?.lang ? { lang: params.lang as string } : undefined);
				break;
			case "searchTransfers":
				result = await client.searchTransfers(params as Parameters<AmadeusClient["searchTransfers"]>[0]);
				break;
			case "getRecommendedLocations":
				result = await client.getRecommendedLocations(params as Parameters<AmadeusClient["getRecommendedLocations"]>[0]);
				break;
			default:
				return { success: false, error: `Unknown API: ${apiName}` };
		}
		return { success: true, data: result };
	} catch (err) {
		return { success: false, error: err instanceof Error ? err.message : String(err) };
	}
}

async function ingestAmadeusResult(
	env: Env,
	result: Record<string, unknown>,
	type: string,
	city?: string,
): Promise<void> {
	try {
		const amadeusId = (result.id ?? result.hotelId ?? result.activityId ?? result.poiId) as string | null;
		if (!amadeusId) return;
		const kvKey = `amadeus:${type}:${amadeusId}`;
		const existing = await env.KVNAMESPACE.get(kvKey);
		if (existing) return;
		let summary = "";
		const tags: string[] = [];
		switch (type) {
			case "hotel":
				summary = summarizeHotel(result);
				if (result.price) tags.push("hotel");
				if (result.rating) tags.push(`rating-${Math.floor(Number(result.rating))}`);
				break;
			case "flight":
				summary = summarizeFlight(result);
				tags.push("flight");
				if (result.price) {
					const p = parseFloat(String((result.price as Record<string, unknown>)?.total ?? result.price));
					if (p < 300) tags.push("budget"); else if (p < 800) tags.push("midrange"); else tags.push("premium");
				}
				break;
			case "activity":
				summary = summarizeActivity(result);
				tags.push("activity");
				if (result.category) tags.push(String(result.category).toLowerCase());
				break;
			default:
				summary = JSON.stringify(result).substring(0, 500);
				tags.push(type);
		}
		if (!summary || summary.length < 20) return;
		const embedding = await generateEmbedding(env, summary);
		const metadata = {
			amadeusId: String(amadeusId),
			city: city ?? "unknown",
			type,
			tags: tags.join(","),
			createdAt: Date.now(),
			source: "amadeus",
			text: summary,
		};
		await env.VECTORIZE.upsert([{ id: `amadeus-${type}-${amadeusId}`, values: embedding, metadata }]);
		await env.KVNAMESPACE.put(kvKey, JSON.stringify({ ingestedAt: Date.now(), type, city }));
	} catch (e) {
		console.error("Pipeline ingestAmadeusResult error:", e);
	}
}

async function useTools(env: Env, message: string, tripState: PipelineTripState): Promise<string> {
	try {
		console.log("[Pipeline Tools] Determining Amadeus API call for message");
		const client = new AmadeusClient({
			AMADEUS_API_KEY: env.AMADEUS_API_KEY,
			AMADEUS_API_SECRET: env.AMADEUS_API_SECRET,
		});
		let apiCall = await determineAmadeusAPICall(env, message, tripState);
		const basics = tripState.basics || {};
		const city = basics.destination;
		if (!apiCall?.apiName) {
			const lower = message.toLowerCase();
			if (lower.includes("flight") && basics.destination && basics.startDate) {
				apiCall = { apiName: "searchFlightOffers", params: { origin: "NYC", destination: basics.destination, departureDate: basics.startDate, returnDate: basics.endDate } };
			} else if ((lower.includes("hotel") || lower.includes("accommodation")) && basics.destination) {
				apiCall = { apiName: "searchHotelOffers", params: { cityCode: city, checkInDate: basics.startDate, checkOutDate: basics.endDate, adults: 2 } };
			} else if (lower.includes("activity") || lower.includes("tour") || lower.includes("things to do")) {
				apiCall = { apiName: "searchActivities", params: { latitude: 48.8566, longitude: 2.3522, radius: 5, pageLimit: 10 } };
			} else {
				return "";
			}
		}
		if (!apiCall?.apiName) {
			console.log("[Pipeline Tools] No API call determined, skipping");
			return "";
		}
		console.log("[Pipeline Tools] Calling Amadeus API:", apiCall.apiName);
		console.log("[Pipeline Tools] Amadeus API raw input:", JSON.stringify({ apiName: apiCall.apiName, params: apiCall.params }, null, 2));
		const result = await callAmadeusAPI(client, apiCall.apiName, apiCall.params as Record<string, unknown>);
		const toolResults: string[] = [];
		if (result.success && result.data) {
			let resultType = "general";
			if (apiCall.apiName.includes("Flight") || apiCall.apiName.includes("flight")) resultType = "flight";
			else if (apiCall.apiName.includes("Hotel") || apiCall.apiName.includes("hotel")) resultType = "hotel";
			else if (apiCall.apiName.includes("Activity") || apiCall.apiName.includes("activity")) resultType = "activity";
			else if (apiCall.apiName.includes("Transfer") || apiCall.apiName.includes("transfer")) resultType = "transfer";
			else if (apiCall.apiName.includes("Location") || apiCall.apiName.includes("location") || apiCall.apiName.includes("City") || apiCall.apiName.includes("city")) resultType = "location";
			const data = result.data as { data?: unknown[] } | unknown[];
			let results: unknown[] = [];
			if (data && typeof data === "object" && "data" in data && Array.isArray((data as { data: unknown[] }).data)) results = (data as { data: unknown[] }).data;
			else if (Array.isArray(data)) results = data;
			else if (typeof data === "object") results = [data];
			if (results.length > 0 && ["flight", "hotel", "activity"].includes(resultType)) {
				for (const item of results.slice(0, 5) as Record<string, unknown>[]) {
					await ingestAmadeusResult(env, item, resultType, city);
				}
			}
			toolResults.push(results.length > 0 ? `Found ${results.length} result(s) from ${apiCall.apiName}` : `API call to ${apiCall.apiName} succeeded but returned no results`);
		} else {
			toolResults.push(`API call error (${apiCall.apiName}): ${result.error ?? "Failed"}`);
		}
		const summary = toolResults.join("; ");
		console.log("[Pipeline Tools] Amadeus result:", result.success ? "success" : "error", "| summary length:", summary.length);
		console.log("[Pipeline Tools] Amadeus summary:", summary);
		return toolResults.length > 0 ? `[Tool Results: ${summary}]` : "";
	} catch (e) {
		console.error("[Pipeline Tools] useTools error:", e);
		return `[Tool Error: ${e instanceof Error ? e.message : "Unknown error"}]`;
	}
}

const MAX_HISTORY_MESSAGES = 10;

async function generateLLMResponse(
	env: Env,
	userMessage: string,
	ragContext: string,
	toolResults: string,
	tripState: PipelineTripState,
): Promise<ReadableStream> {
	const basics = tripState.basics || {};
	const prefs = tripState.preferences || [];
	const history = (tripState.recentMessages || []).slice(-MAX_HISTORY_MESSAGES);
	const systemPrompt = `You are a helpful travel assistant. You help users plan trips, find flights, and discover destinations.

Current trip information:
- Destination: ${basics.destination ?? "Not specified"}
- Dates: ${basics.startDate ?? "Not specified"} to ${basics.endDate ?? "Not specified"}
- Budget: ${basics.budget ? `$${basics.budget}` : "Not specified"}
- Preferences: ${prefs.join(", ") || "None specified"}

${ragContext ? `\nRelevant context: ${ragContext}` : ""}
${toolResults ? `\nTool results: ${toolResults}` : ""}

Provide helpful, personalized travel advice based on the user's query and the information available. Use the conversation history when provided to remember context and preferences.`;
	const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
		{ role: "system", content: systemPrompt },
		...history.map((m) => ({ role: m.role, content: m.content })),
		{ role: "user", content: userMessage },
	];
	console.log("[Pipeline LLM] Calling Workers AI (stream: true), history messages:", history.length);
	const aiResponse = await env.AI.run(LLM_MODEL, { messages, max_tokens: 1024, stream: true });
	if (!aiResponse) throw new Error("AI.run returned null");
	if (!(aiResponse instanceof ReadableStream)) throw new Error(`AI.run did not return ReadableStream, got: ${typeof aiResponse}`);
	return aiResponse as ReadableStream;
}

/**
 * Run the full pipeline in the Worker: RAG + tools (parallel with timeouts) then LLM stream.
 * Returns a ReadableStream (SSE from Workers AI).
 */
export async function runPipeline(
	env: Env,
	message: string,
	tripState: PipelineTripState = defaultTripState,
): Promise<ReadableStream> {
	const needsRAG = shouldUseRAG(message);
	const needsTools = shouldUseTools(message);
	console.log("[Pipeline] message:", message.slice(0, 60) + (message.length > 60 ? "…" : ""), "| RAG:", needsRAG, "| Tools:", needsTools);
	const ragPromise = needsRAG
		? Promise.race([
				performRAG(env, message, tripState.basics?.destination),
				new Promise<string>((r) => setTimeout(() => r(""), RAG_TIMEOUT_MS)),
			])
		: Promise.resolve("");
	const toolsPromise = needsTools
		? Promise.race([
				useTools(env, message, tripState),
				new Promise<string>((r) => setTimeout(() => r(""), TOOLS_TIMEOUT_MS)),
			])
		: Promise.resolve("");
	const [ragResult, toolsResult] = await Promise.all([ragPromise, toolsPromise]);
	console.log("[Pipeline] RAG result length:", ragResult?.length ?? 0, "| Tools result length:", toolsResult?.length ?? 0, "| History:", tripState.recentMessages?.length ?? 0);
	return generateLLMResponse(env, message, ragResult, toolsResult, tripState);
}

/**
 * Parse SSE chunks from Workers AI stream; returns text contents and remaining buffer.
 */
export function parseSSEChunk(buffer: string): { contents: string[]; buffer: string } {
	const contents: string[] = [];
	let remainingBuffer = buffer.replace(/\r/g, "");
	let eventEndIndex: number;
	while ((eventEndIndex = remainingBuffer.indexOf("\n\n")) !== -1) {
		const rawEvent = remainingBuffer.slice(0, eventEndIndex);
		remainingBuffer = remainingBuffer.slice(eventEndIndex + 2);
		for (const line of rawEvent.split("\n")) {
			if (!line.startsWith("data:")) continue;
			const data = line.slice(5).trimStart();
			if (data === "[DONE]") continue;
			try {
				const jsonData = JSON.parse(data) as { response?: string; choices?: Array<{ delta?: { content?: string } }>; content?: string };
				if (typeof jsonData.response === "string" && jsonData.response.length > 0) contents.push(jsonData.response);
				else if (typeof jsonData.choices?.[0]?.delta?.content === "string") contents.push(jsonData.choices[0].delta.content!);
				else if (typeof jsonData.content === "string" && jsonData.content.length > 0) contents.push(jsonData.content);
			} catch {
				if (data && data !== "[DONE]") contents.push(data);
			}
		}
	}
	return { contents, buffer: remainingBuffer };
}
