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

/** Required params and data format per Amadeus API (for logging before raw input). */
const AMADEUS_API_SPEC: Record<string, { requiredParams: string[]; optionalParams?: string[]; dataFormat: string }> = {
	searchFlightOffers: {
		requiredParams: ["originLocationCode", "destinationLocationCode", "departureDate"],
		optionalParams: ["returnDate", "adults", "children", "infants", "travelClass", "nonStop", "max"],
		dataFormat: "GET query params: originLocationCode, destinationLocationCode, departureDate (YYYY-MM-DD); returnDate optional",
	},
	getFlightOfferPrice: { requiredParams: ["flightOffer"], optionalParams: [], dataFormat: "POST body: flightOffer object from searchFlightOffers" },
	searchFlightDestinations: { requiredParams: ["origin"], optionalParams: ["departureDate", "oneWay"], dataFormat: "GET query params" },
	searchCheapestFlightDates: { requiredParams: ["origin", "destination"], optionalParams: ["departureDate"], dataFormat: "GET query params" },
	getMostTraveledDestinations: { requiredParams: ["originCityCode"], optionalParams: ["period"], dataFormat: "GET query params" },
	getMostBookedDestinations: { requiredParams: ["originCityCode"], optionalParams: ["period"], dataFormat: "GET query params" },
	getBusiestPeriod: { requiredParams: ["cityCode"], optionalParams: ["period", "direction"], dataFormat: "GET query params" },
	getFlightAvailabilities: { requiredParams: ["availabilityRequest"], optionalParams: [], dataFormat: "POST body: availabilityRequest" },
	getSeatmap: { requiredParams: ["flightOffer"], optionalParams: [], dataFormat: "POST body: flightOffer" },
	getFlightStatus: { requiredParams: ["carrierCode", "flightNumber", "scheduledDepartureDate"], optionalParams: [], dataFormat: "GET query params" },
	searchAirlines: { requiredParams: [], optionalParams: ["airlineCodes"], dataFormat: "GET query params" },
	getAirlineRoutes: { requiredParams: ["departureAirportCode"], optionalParams: ["max"], dataFormat: "GET query params" },
	searchLocations: { requiredParams: ["subType"], optionalParams: ["keyword", "countryCode"], dataFormat: "GET query params; subType: AIRPORT, CITY, etc." },
	getAirportNearestRelevant: { requiredParams: ["latitude", "longitude"], optionalParams: ["radius"], dataFormat: "GET query params" },
	getAirportRoutes: { requiredParams: ["departureAirportCode"], optionalParams: ["max"], dataFormat: "GET query params" },
	getBrandedFaresUpsell: { requiredParams: ["flightOffer"], optionalParams: [], dataFormat: "POST body: flightOffer" },
	getFlightCheckinLinks: { requiredParams: ["airlineCode"], optionalParams: [], dataFormat: "GET query params" },
	getAirportOnTimePerformance: { requiredParams: ["airportCode", "date"], optionalParams: [], dataFormat: "GET query params" },
	searchCities: { requiredParams: [], optionalParams: ["keyword", "countryCode", "max"], dataFormat: "GET query params" },
	searchHotelsByGeocode: { requiredParams: ["latitude", "longitude"], optionalParams: ["radius", "checkIn", "checkOut"], dataFormat: "GET query params" },
	searchHotelsByCity: { requiredParams: ["cityCode"], optionalParams: ["hotelSource"], dataFormat: "GET query params" },
	searchHotelOffers: {
		requiredParams: [],
		optionalParams: ["hotelIds", "cityCode", "latitude", "longitude", "checkInDate", "checkOutDate", "adults", "roomQuantity"],
		dataFormat: "GET query params; need cityCode or (latitude+longitude); checkInDate/checkOutDate YYYY-MM-DD",
	},
	searchHotelNameAutocomplete: { requiredParams: ["keyword"], optionalParams: ["hotelSource", "max"], dataFormat: "GET query params" },
	getHotelRatings: { requiredParams: ["hotelIds"], optionalParams: [], dataFormat: "GET query params; hotelIds comma-separated" },
	searchActivities: { requiredParams: [], optionalParams: ["latitude", "longitude", "radius", "pageLimit"], dataFormat: "GET query params" },
	getActivity: { requiredParams: ["activityId"], optionalParams: ["lang"], dataFormat: "GET path + query params" },
	searchTransfers: { requiredParams: ["originLocationCode", "destinationLocationCode", "departureDateTime"], optionalParams: [], dataFormat: "GET query params" },
	getRecommendedLocations: { requiredParams: [], optionalParams: ["cityCodes", "travelerCountryCode"], dataFormat: "GET query params" },
};

/** Human-readable prompt for the user when a required param is missing (API -> message for LLM to ask). */
const MISSING_PARAM_ASK_USER: Record<string, Record<string, string>> = {
	searchFlightOffers: {
		originLocationCode: "To find flights I need your departure city or airport code. Where will you be flying from? (e.g. NYC, Dallas, LAX)",
		destinationLocationCode: "I need the destination city or airport code. Where would you like to fly to?",
		departureDate: "What date will you be departing? (e.g. 2025-06-15 or 'next Friday')",
	},
	searchTransfers: {
		originLocationCode: "Which airport or location will you be transferred from?",
		destinationLocationCode: "Which airport or location is your transfer destination?",
		departureDateTime: "When do you need the transfer? (date and time)",
	},
	searchHotelOffers: {
		cityCode: "Which city will you be staying in? I need the city or city code for hotel search.",
		checkInDate: "What is your check-in date? (YYYY-MM-DD)",
		checkOutDate: "What is your check-out date? (YYYY-MM-DD)",
	},
};

/**
 * Resolve API params from tripState and incoming params; check required params.
 * Returns either { ok: true, params } or { ok: false, askUser } so the orchestrator can ask the user instead of calling the API.
 */
function resolveApiParamsAndCheckMissing(
	apiName: string,
	params: Record<string, unknown>,
	tripState: PipelineTripState,
): { ok: true; params: Record<string, unknown> } | { ok: false; askUser: string; missingParams: string[] } {
	const basics = tripState.basics || {};
	const resolved = { ...params };

	// Map tripState.basics into API param names where applicable
	if (apiName === "searchFlightOffers") {
		resolved.originLocationCode = resolved.originLocationCode ?? resolved.origin ?? basics.origin;
		resolved.destinationLocationCode = resolved.destinationLocationCode ?? resolved.destination ?? basics.destination;
		resolved.departureDate = resolved.departureDate ?? basics.startDate;
		resolved.returnDate = resolved.returnDate ?? basics.endDate;
	}
	if (apiName === "searchHotelOffers") {
		resolved.cityCode = resolved.cityCode ?? basics.destination;
		resolved.checkInDate = resolved.checkInDate ?? basics.startDate;
		resolved.checkOutDate = resolved.checkOutDate ?? basics.endDate;
	}
	if (apiName === "searchTransfers") {
		resolved.originLocationCode = resolved.originLocationCode ?? resolved.origin ?? basics.origin;
		resolved.destinationLocationCode = resolved.destinationLocationCode ?? resolved.destination ?? basics.destination;
		resolved.departureDateTime = resolved.departureDateTime ?? basics.startDate;
	}

	const spec = AMADEUS_API_SPEC[apiName];
	if (!spec || !spec.requiredParams.length) {
		return { ok: true, params: resolved };
	}

	const missingKeys: string[] = [];
	const askMessages: string[] = [];
	for (const key of spec.requiredParams) {
		const val = resolved[key];
		if (val !== undefined && val !== null && String(val).trim() !== "") continue;
		missingKeys.push(key);
		const askMap = MISSING_PARAM_ASK_USER[apiName];
		askMessages.push(askMap?.[key] ?? `Please provide: ${key}`);
	}

	if (missingKeys.length > 0) {
		return { ok: false, askUser: askMessages[0], missingParams: missingKeys };
	}
	return { ok: true, params: resolved };
}

/** Flow intents: once set, subsequent messages are treated as part of this flow until changed or a global intent. */
export const FLOW_INTENTS = [
	"Plan_Trip",
	"Search_Flights",
	"Search_Hotels",
	"Search_Activities",
	"Get_Recommendations",
	"Open_New_Account",
	"Book_Flight",
	"Book_Hotel",
	"Multi_City",
] as const;

/** Global intents: clear the current flow and optionally start a new one or cancel. */
export const GLOBAL_INTENTS = ["Cancel", "Start_Over", "New_Search", "Help", "General"] as const;

export type FlowIntent = (typeof FLOW_INTENTS)[number];
export type GlobalIntent = (typeof GLOBAL_INTENTS)[number];

export interface PipelineTripState {
	basics?: { origin?: string; destination?: string; startDate?: string; endDate?: string; budget?: number };
	preferences?: string[];
	/** Last N messages for LLM context (user/assistant). Capped when stored. */
	recentMessages?: Array<{ role: "user" | "assistant"; content: string }>;
	/** Current conversation intent (State Object). All subsequent prompts are treated as part of this flow until a global intent or explicit change. */
	currentIntent?: string | null;
}

const defaultTripState: PipelineTripState = {
	basics: {},
	preferences: [],
};

/** Result of a single intent + new-trip classification call (one LLM call). */
export interface ConversationClassification {
	/** New currentIntent for State Object; null if global intent. */
	intent: string | null;
	/** True when we should save current thread and start a new one (different trip, or Start_Over/New_Search). */
	isNewTrip: boolean;
}

/** Extract first JSON object from LLM response text. */
function parseLLMJson<T>(response: unknown): T | null {
	let text = "";
	if (typeof response === "string") text = response;
	else if (response && typeof response === "object" && "response" in response) text = String((response as { response: unknown }).response);
	else text = JSON.stringify(response);
	const jsonMatch = text.match(/\{[\s\S]*\}/);
	if (!jsonMatch) return null;
	try {
		return JSON.parse(jsonMatch[0]) as T;
	} catch {
		return null;
	}
}

/**
 * Single classifier: intent + whether to start a new trip thread.
 * Use this instead of calling detectIntent and detectNewTrip separately.
 * - intent: new currentIntent (null for global intents).
 * - isNewTrip: true when user starts a different trip or says start over/new search (and we have something to save).
 */
export async function classifyConversation(
	env: Env,
	message: string,
	currentIntent: string | null,
	currentBasics: { destination?: string; origin?: string },
	hasExistingMessages: boolean,
): Promise<ConversationClassification> {
	const flowList = FLOW_INTENTS.join(", ");
	const globalList = GLOBAL_INTENTS.join(", ");
	const dest = currentBasics.destination ?? "";
	const origin = currentBasics.origin ?? "";
	const prompt = `You are a conversation classifier for a travel assistant.

User message: "${message}"
Current conversation intent: ${currentIntent ?? "null"}
Current trip context: destination=${dest || "none"}, origin=${origin || "none"}.

Respond with ONLY a JSON object:
{ "intent": "<IntentName>" | null, "isGlobal": boolean, "isNewTrip": boolean }

- Flow intents (user starting or continuing a task): ${flowList}
- Global intents (cancel, start over, new search, help): ${globalList}

Rules:
- intent: the flow intent name if starting/continuing a flow; the global name if cancel/start over/help; null if continuing current flow.
- isGlobal: true only for global intents (Cancel, Start_Over, New_Search, Help, General).
- isNewTrip: true if the user is starting a NEW or DIFFERENT trip (e.g. new destination, "plan another trip", "now plan a trip to Paris") OR says start over / new search. false if continuing the current trip (e.g. "from Dallas", "yes", adding details). Only set true when they clearly start a different trip or reset.
- If ambiguous, prefer continuing (intent null, isGlobal false, isNewTrip false).`;

	try {
		const response = await env.AI.run(LLM_MODEL, {
			messages: [
				{ role: "system", content: "You are a classifier. Respond with only valid JSON: { intent: string | null, isGlobal: boolean, isNewTrip: boolean }." },
				{ role: "user", content: prompt },
			],
			max_tokens: 100,
		});
		const parsed = parseLLMJson<{ intent?: string | null; isGlobal?: boolean; isNewTrip?: boolean }>(response);
		if (!parsed) {
			return { intent: currentIntent, isNewTrip: false };
		}
		const isGlobal = parsed.isGlobal === true || GLOBAL_INTENTS.includes((parsed.intent ?? "") as GlobalIntent);
		const intent: string | null = isGlobal ? null : (typeof parsed.intent === "string" && parsed.intent.trim() ? parsed.intent.trim() : currentIntent);
		const isNewTrip = hasExistingMessages && (parsed.isNewTrip === true || isGlobal && (parsed.intent === "Start_Over" || parsed.intent === "New_Search"));
		if (isGlobal) console.log("[Pipeline State] Global intent:", parsed.intent, "— clearing currentIntent");
		else if (intent !== currentIntent) console.log("[Pipeline State] New flow intent:", intent, "(previous:", currentIntent ?? "null", ")");
		if (isNewTrip) console.log("[Pipeline State] New trip detected — will save current thread");
		return { intent, isNewTrip };
	} catch (e) {
		console.error("[Pipeline] classifyConversation error:", e);
		return { intent: currentIntent, isNewTrip: false };
	}
}

/**
 * Detect conversation intent only (for callers that don't need trip-thread logic).
 * Prefer classifyConversation when you need both intent and isNewTrip to avoid a second LLM call.
 */
export async function detectIntent(
	env: Env,
	message: string,
	currentIntent: string | null,
): Promise<string | null> {
	const result = await classifyConversation(env, message, currentIntent, {}, false);
	return result.intent;
}

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
- Origin (departure city/code): ${basics.origin ?? "not specified"}
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
		const parsed = parseLLMJson<{ apiName?: string | null; params?: Record<string, unknown> }>(response);
		if (!parsed || !parsed.apiName || parsed.apiName === "null") return null;
		return { apiName: parsed.apiName, params: parsed.params ?? {} };
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
			if (lower.includes("flight") && (basics.destination || basics.startDate)) {
				apiCall = { apiName: "searchFlightOffers", params: { origin: basics.origin, destination: basics.destination, departureDate: basics.startDate, returnDate: basics.endDate } };
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

		const resolved = resolveApiParamsAndCheckMissing(apiCall.apiName, (apiCall.params || {}) as Record<string, unknown>, tripState);
		if (!resolved.ok) {
			const spec = AMADEUS_API_SPEC[apiCall.apiName] ?? { requiredParams: [], optionalParams: [], dataFormat: "" };
			console.log(
				"[Pipeline Tools] Missing required params — expected API input:",
				JSON.stringify(
					{
						apiName: apiCall.apiName,
						requiredParams: spec.requiredParams,
						optionalParams: spec.optionalParams,
						dataFormat: spec.dataFormat,
						missingParams: resolved.missingParams,
						currentParams: apiCall.params,
					},
					null,
					2,
				),
			);
			return `[Missing required info for ${apiCall.apiName}. Ask the user: "${resolved.askUser}" Use your next response to ask them; when they reply, their answer will be in context for the next API call.]`;
		}
		const finalParams = resolved.params;

		console.log("[Pipeline Tools] Calling Amadeus API:", apiCall.apiName);
		const spec = AMADEUS_API_SPEC[apiCall.apiName] ?? { requiredParams: [], optionalParams: [], dataFormat: "see Amadeus API docs" };
		console.log("[Pipeline Tools] Amadeus API required params and data format:", JSON.stringify({ apiName: apiCall.apiName, ...spec }, null, 2));
		console.log("[Pipeline Tools] Amadeus API raw input:", JSON.stringify({ apiName: apiCall.apiName, params: finalParams }, null, 2));
		const result = await callAmadeusAPI(client, apiCall.apiName, finalParams as Record<string, unknown>);
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

async function summarizeHistory(
	env: Env,
	messages: Array<{ role: "user" | "assistant"; content: string }>,
): Promise<string> {
	if (!messages.length) return "";
	const joined = messages
		.map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
		.join("\n");
	const maxChars = 3000;
	const clipped = joined.length > maxChars ? joined.slice(-maxChars) : joined;
	try {
		const response = await env.AI.run(LLM_MODEL, {
			messages: [
				{
					role: "system",
					content:
						"You are a travel conversation summarizer. Produce a concise summary that preserves all important constraints (dates, budget, locations) and user preferences. Respond with 3-6 short bullet points in plain text.",
				},
				{ role: "user", content: clipped },
			],
			max_tokens: 256,
		});
		let text = "";
		if (typeof response === "string") text = response;
		else if (response && typeof response === "object" && "response" in response)
			text = String((response as { response: unknown }).response);
		else text = JSON.stringify(response);
		return text.trim();
	} catch (e) {
		console.error("[Pipeline] summarizeHistory error:", e);
		return "";
	}
}

async function generateLLMResponse(
	env: Env,
	userMessage: string,
	ragContext: string,
	toolResults: string,
	tripState: PipelineTripState,
): Promise<ReadableStream> {
	const basics = tripState.basics || {};
	const prefs = tripState.preferences || [];
	const fullHistory = tripState.recentMessages || [];

	let summaryText = "";
	let historyForContext = fullHistory;
	if (fullHistory.length > MAX_HISTORY_MESSAGES) {
		const older = fullHistory.slice(0, fullHistory.length - MAX_HISTORY_MESSAGES);
		historyForContext = fullHistory.slice(-MAX_HISTORY_MESSAGES);
		summaryText = await summarizeHistory(env, older);
	}

	const currentIntent = tripState.currentIntent ?? null;
	const systemPrompt = `You are a helpful travel assistant. You help users plan trips, find flights, and discover destinations.

Current conversation state (State Object):
- Active intent: ${currentIntent ?? "none"}
${currentIntent ? `Treat every subsequent user message as part of this flow ("${currentIntent}") until the user explicitly changes topic, says cancel/start over, or triggers a global intent. Do not treat their reply as a new unrelated request.` : ""}

Current trip information:
- Destination: ${basics.destination ?? "Not specified"}
- Dates: ${basics.startDate ?? "Not specified"} to ${basics.endDate ?? "Not specified"}
- Budget: ${basics.budget ? `$${basics.budget}` : "Not specified"}
- Preferences: ${prefs.join(", ") || "None specified"}

${ragContext ? `\nRelevant context: ${ragContext}` : ""}
${toolResults ? `\nTool results: ${toolResults}` : ""}

Provide helpful, personalized travel advice based on the user's query and the information available. Use the conversation history when provided to remember context and preferences.
If tool results indicate "Missing required info" and tell you to ask the user something, respond by asking the user exactly that in a friendly way. Do not make up or assume values. Once the user replies with the missing information (e.g. departure city, dates), that context will be saved and the next message can proceed with the API call.`;

	const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
		{ role: "system", content: systemPrompt },
		...(summaryText
			? [
					{
						role: "system" as const,
						content: `Summary of earlier conversation:\n${summaryText}`,
					},
			  ]
			: []),
		...historyForContext.map((m) => ({ role: m.role, content: m.content })),
		{ role: "user", content: userMessage },
	];

	console.log(
		"[Pipeline LLM] Calling Workers AI (stream: true), recent messages:",
		historyForContext.length,
		"older summarized:",
		fullHistory.length > MAX_HISTORY_MESSAGES ? fullHistory.length - MAX_HISTORY_MESSAGES : 0,
	);

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
	console.log("[Pipeline] runPipeline start");
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
	console.log("[Pipeline] calling generateLLMResponse (stream: true)");
	const stream = await generateLLMResponse(env, message, ragResult, toolsResult, tripState);
	console.log("[Pipeline] runPipeline done, returning stream");
	return stream;
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
