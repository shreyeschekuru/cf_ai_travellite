/**
 * Amadeus API Client
 * 
 * Implementation of the official 30 Amadeus for Developers APIs
 * Organized by category: Flights (19), Hotels (4), Destination Experience (2), Transfer (1), Other (1)
 * 
 * Documentation: https://developers.amadeus.com/self-service
 * Official API List: Based on Amadeus API Usage page for "travellite" app
 */

export interface AmadeusEnv {
	AMADEUS_API_KEY: string;
	AMADEUS_API_SECRET: string;
}

/**
 * Amadeus API Client Class
 * Handles authentication and all API calls
 * Always uses sandbox/test environment (https://test.api.amadeus.com)
 */
export class AmadeusClient {
	private env: AmadeusEnv;
	private baseUrl: string;
	private accessToken: string | null = null;
	private tokenExpiry: number = 0;

	constructor(env: AmadeusEnv) {
		this.env = env;
		// Always use sandbox/test environment
		this.baseUrl = "https://test.api.amadeus.com";
	}

	/**
	 * Get or refresh Amadeus access token
	 */
	async getAccessToken(): Promise<string> {
		// Return cached token if still valid (with 5 minute buffer)
		if (this.accessToken && Date.now() < this.tokenExpiry - 300000) {
			return this.accessToken;
		}

		const response = await fetch(`${this.baseUrl}/v1/security/oauth2/token`, {
			method: "POST",
			headers: {
				"Content-Type": "application/x-www-form-urlencoded",
			},
			body: new URLSearchParams({
				grant_type: "client_credentials",
				client_id: this.env.AMADEUS_API_KEY,
				client_secret: this.env.AMADEUS_API_SECRET,
			}),
		});

		if (!response.ok) {
			const errorText = await response.text();
			throw new Error(`Failed to get Amadeus access token: ${errorText}`);
		}

		const data = (await response.json()) as {
			access_token: string;
			expires_in: number;
		};

		this.accessToken = data.access_token;
		this.tokenExpiry = Date.now() + data.expires_in * 1000;

		return this.accessToken;
	}

	/**
	 * Make authenticated API request
	 */
	private async request(
		endpoint: string,
		options: RequestInit = {},
	): Promise<Response> {
		const token = await this.getAccessToken();
		const url = `${this.baseUrl}${endpoint}`;

		const headers = new Headers(options.headers);
		headers.set("Authorization", `Bearer ${token}`);

		return fetch(url, {
			...options,
			headers,
		});
	}

	// ============================================================================
	// FLIGHT APIs (19 APIs)
	// ============================================================================

	/**
	 * 1. Flight Offers Search
	 * GET /v2/shopping/flight-offers
	 */
	async searchFlightOffers(params: {
		originLocationCode: string;
		destinationLocationCode: string;
		departureDate: string;
		returnDate?: string;
		adults?: number;
		children?: number;
		infants?: number;
		travelClass?: string;
		nonStop?: boolean;
		max?: number;
	}): Promise<any> {
		const searchParams = new URLSearchParams({
			originLocationCode: params.originLocationCode,
			destinationLocationCode: params.destinationLocationCode,
			departureDate: params.departureDate,
			adults: String(params.adults || 1),
			max: String(params.max || 5),
		});

		if (params.returnDate) searchParams.append("returnDate", params.returnDate);
		if (params.children) searchParams.append("children", String(params.children));
		if (params.infants) searchParams.append("infants", String(params.infants));
		if (params.travelClass) searchParams.append("travelClass", params.travelClass);
		if (params.nonStop) searchParams.append("nonStop", "true");

		const response = await this.request(`/v2/shopping/flight-offers?${searchParams}`);
		if (!response.ok) {
			const error = await response.text();
			throw new Error(`Flight Offers Search failed: ${error}`);
		}
		return response.json();
	}

	/**
	 * 2. Flight Offers Price
	 * POST /v1/shopping/flight-offers/pricing
	 */
	async getFlightOfferPrice(flightOffer: any): Promise<any> {
		const response = await this.request("/v1/shopping/flight-offers/pricing", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ data: { type: "flight-offers-pricing", flightOffers: [flightOffer] } }),
		});
		if (!response.ok) {
			const error = await response.text();
			throw new Error(`Flight Offer Price failed: ${error}`);
		}
		return response.json();
	}

	/**
	 * 3. Flight Inspiration Search
	 * GET /v1/shopping/flight-destinations
	 */
	async searchFlightDestinations(params: {
		origin: string;
		departureDate?: string;
		oneWay?: boolean;
		duration?: string;
		nonStop?: boolean;
		maxPrice?: number;
		viewBy?: string;
	}): Promise<any> {
		const searchParams = new URLSearchParams({ origin: params.origin });
		if (params.departureDate) searchParams.append("departureDate", params.departureDate);
		if (params.oneWay) searchParams.append("oneWay", "true");
		if (params.duration) searchParams.append("duration", params.duration);
		if (params.nonStop) searchParams.append("nonStop", "true");
		if (params.maxPrice) searchParams.append("maxPrice", String(params.maxPrice));
		if (params.viewBy) searchParams.append("viewBy", params.viewBy);

		const response = await this.request(`/v1/shopping/flight-destinations?${searchParams}`);
		if (!response.ok) {
			const error = await response.text();
			throw new Error(`Flight Inspiration Search failed: ${error}`);
		}
		return response.json();
	}

	/**
	 * 4. Flight Cheapest Date Search
	 * GET /v1/shopping/flight-dates
	 */
	async searchCheapestFlightDates(params: {
		origin: string;
		destination: string;
		departureDate?: string;
		duration?: string;
		oneWay?: boolean;
		nonStop?: boolean;
		viewBy?: string;
	}): Promise<any> {
		const searchParams = new URLSearchParams({
			origin: params.origin,
			destination: params.destination,
		});
		if (params.departureDate) searchParams.append("departureDate", params.departureDate);
		if (params.duration) searchParams.append("duration", params.duration);
		if (params.oneWay) searchParams.append("oneWay", "true");
		if (params.nonStop) searchParams.append("nonStop", "true");
		if (params.viewBy) searchParams.append("viewBy", params.viewBy);

		const response = await this.request(`/v1/shopping/flight-dates?${searchParams}`);
		if (!response.ok) {
			const error = await response.text();
			throw new Error(`Cheapest Flight Dates failed: ${error}`);
		}
		return response.json();
	}

	/**
	 * 5. Flight Most Traveled Destinations
	 * GET /v1/travel/analytics/air-traffic/traveled
	 */
	async getMostTraveledDestinations(params: {
		originCityCode: string;
		period?: string;
	}): Promise<any> {
		const searchParams = new URLSearchParams({ originCityCode: params.originCityCode });
		if (params.period) searchParams.append("period", params.period);

		const response = await this.request(`/v1/travel/analytics/air-traffic/traveled?${searchParams}`);
		if (!response.ok) {
			const error = await response.text();
			throw new Error(`Most Traveled Destinations failed: ${error}`);
		}
		return response.json();
	}

	/**
	 * 6. Flight Most Booked Destinations
	 * GET /v1/travel/analytics/air-traffic/booked
	 */
	async getMostBookedDestinations(params: {
		originCityCode: string;
		period?: string;
	}): Promise<any> {
		const searchParams = new URLSearchParams({ originCityCode: params.originCityCode });
		if (params.period) searchParams.append("period", params.period);

		const response = await this.request(`/v1/travel/analytics/air-traffic/booked?${searchParams}`);
		if (!response.ok) {
			const error = await response.text();
			throw new Error(`Most Booked Destinations failed: ${error}`);
		}
		return response.json();
	}

	/**
	 * 7. Flight Busiest Traveling Period
	 * GET /v1/travel/analytics/air-traffic/busiest-period
	 */
	async getBusiestPeriod(params: {
		cityCode: string;
		period?: string;
		direction?: string;
	}): Promise<any> {
		const searchParams = new URLSearchParams({ cityCode: params.cityCode });
		if (params.period) searchParams.append("period", params.period);
		if (params.direction) searchParams.append("direction", params.direction);

		const response = await this.request(`/v1/travel/analytics/air-traffic/busiest-period?${searchParams}`);
		if (!response.ok) {
			const error = await response.text();
			throw new Error(`Busiest Period failed: ${error}`);
		}
		return response.json();
	}

	/**
	 * 8. Flight Availabilities Search
	 * POST /v1/shopping/availability/flight-availabilities
	 */
	async getFlightAvailabilities(availabilityRequest: any): Promise<any> {
		const response = await this.request("/v1/shopping/availability/flight-availabilities", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(availabilityRequest),
		});
		if (!response.ok) {
			const error = await response.text();
			throw new Error(`Flight Availabilities failed: ${error}`);
		}
		return response.json();
	}

	/**
	 * 9. SeatMap Display
	 * POST /v1/shopping/seatmaps
	 */
	async getSeatmap(flightOffer: any): Promise<any> {
		const response = await this.request("/v1/shopping/seatmaps", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ data: { type: "seatmap", flightOfferId: flightOffer.id } }),
		});
		if (!response.ok) {
			const error = await response.text();
			throw new Error(`Seatmap Display failed: ${error}`);
		}
		return response.json();
	}

	/**
	 * 10. On Demand Flight Status
	 * GET /v2/schedule/flights
	 */
	async getFlightStatus(params: {
		carrierCode: string;
		flightNumber: string;
		scheduledDepartureDate: string;
	}): Promise<any> {
		const searchParams = new URLSearchParams({
			carrierCode: params.carrierCode,
			flightNumber: params.flightNumber,
			scheduledDepartureDate: params.scheduledDepartureDate,
		});

		const response = await this.request(`/v2/schedule/flights?${searchParams}`);
		if (!response.ok) {
			const error = await response.text();
			throw new Error(`Flight Status failed: ${error}`);
		}
		return response.json();
	}

	/**
	 * 11. Airline Code Lookup
	 * GET /v1/reference-data/airlines
	 */
	async searchAirlines(params?: {
		airlineCodes?: string;
	}): Promise<any> {
		const searchParams = new URLSearchParams();
		if (params?.airlineCodes) searchParams.append("airlineCodes", params.airlineCodes);

		const url = `/v1/reference-data/airlines${searchParams.toString() ? `?${searchParams}` : ""}`;
		const response = await this.request(url);
		if (!response.ok) {
			const error = await response.text();
			throw new Error(`Airline Code Lookup failed: ${error}`);
		}
		return response.json();
	}

	/**
	 * 12. Airline Routes
	 * GET /v1/airport/direct-destinations
	 */
	async getAirlineRoutes(params: {
		departureAirportCode: string;
		max?: number;
	}): Promise<any> {
		const searchParams = new URLSearchParams({
			departureAirportCode: params.departureAirportCode,
		});
		if (params.max) searchParams.append("max", String(params.max));

		const response = await this.request(`/v1/airport/direct-destinations?${searchParams}`);
		if (!response.ok) {
			const error = await response.text();
			throw new Error(`Airline Routes failed: ${error}`);
		}
		return response.json();
	}

	/**
	 * 13. Airport & City Search
	 * GET /v1/reference-data/locations
	 */
	async searchLocations(params: {
		subType: string; // AIRPORT, CITY, etc.
		keyword?: string;
		countryCode?: string;
		page?: number;
		pageLimit?: number;
	}): Promise<any> {
		const searchParams = new URLSearchParams({ subType: params.subType });
		if (params.keyword) searchParams.append("keyword", params.keyword);
		if (params.countryCode) searchParams.append("countryCode", params.countryCode);
		if (params.page) searchParams.append("page", String(params.page));
		if (params.pageLimit) searchParams.append("pageLimit", String(params.pageLimit));

		const response = await this.request(`/v1/reference-data/locations?${searchParams}`);
		if (!response.ok) {
			const error = await response.text();
			throw new Error(`Airport & City Search failed: ${error}`);
		}
		return response.json();
	}

	/**
	 * 14. Airport Nearest Relevant
	 * GET /v1/reference-data/locations/airports
	 */
	async getAirportNearestRelevant(params: {
		latitude: number;
		longitude: number;
		radius?: number;
		pageLimit?: number;
	}): Promise<any> {
		const searchParams = new URLSearchParams({
			latitude: String(params.latitude),
			longitude: String(params.longitude),
		});
		if (params.radius) searchParams.append("radius", String(params.radius));
		if (params.pageLimit) searchParams.append("pageLimit", String(params.pageLimit));

		const response = await this.request(`/v1/reference-data/locations/airports?${searchParams}`);
		if (!response.ok) {
			const error = await response.text();
			throw new Error(`Airport Nearest Relevant failed: ${error}`);
		}
		return response.json();
	}

	/**
	 * 15. Airport Routes
	 * GET /v1/airport/direct-destinations
	 */
	async getAirportRoutes(params: {
		departureAirportCode: string;
		max?: number;
	}): Promise<any> {
		const searchParams = new URLSearchParams({
			departureAirportCode: params.departureAirportCode,
		});
		if (params.max) searchParams.append("max", String(params.max));

		const response = await this.request(`/v1/airport/direct-destinations?${searchParams}`);
		if (!response.ok) {
			const error = await response.text();
			throw new Error(`Airport Routes failed: ${error}`);
		}
		return response.json();
	}

	/**
	 * 16. Branded Fares Upsell
	 * POST /v1/shopping/flight-offers/upselling
	 */
	async getBrandedFaresUpsell(params: {
		flightOffer: any;
	}): Promise<any> {
		const response = await this.request("/v1/shopping/flight-offers/upselling", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ data: { type: "flight-offers-upselling", flightOffers: [params.flightOffer] } }),
		});
		if (!response.ok) {
			const error = await response.text();
			throw new Error(`Branded Fares Upsell failed: ${error}`);
		}
		return response.json();
	}

	/**
	 * 17. Flight Check-in Links
	 * GET /v1/reference-data/urls/checkin-links
	 */
	async getFlightCheckinLinks(params: {
		airlineCode: string;
	}): Promise<any> {
		const searchParams = new URLSearchParams({
			airlineCode: params.airlineCode,
		});

		const response = await this.request(`/v1/reference-data/urls/checkin-links?${searchParams}`);
		if (!response.ok) {
			const error = await response.text();
			throw new Error(`Flight Check-in Links failed: ${error}`);
		}
		return response.json();
	}

	/**
	 * 18. Airport On-Time Performance
	 * GET /v1/airport/predictions/on-time
	 */
	async getAirportOnTimePerformance(params: {
		airportCode: string;
		date: string;
	}): Promise<any> {
		const searchParams = new URLSearchParams({
			airportCode: params.airportCode,
			date: params.date,
		});

		const response = await this.request(`/v1/airport/predictions/on-time?${searchParams}`);
		if (!response.ok) {
			const error = await response.text();
			throw new Error(`Airport On-Time Performance failed: ${error}`);
		}
		return response.json();
	}

	/**
	 * 19. City Search
	 * GET /v1/reference-data/locations/cities
	 */
	async searchCities(params: {
		keyword?: string;
		countryCode?: string;
		max?: number;
	}): Promise<any> {
		const searchParams = new URLSearchParams();
		if (params.keyword) searchParams.append("keyword", params.keyword);
		if (params.countryCode) searchParams.append("countryCode", params.countryCode);
		if (params.max) searchParams.append("max", String(params.max));

		const response = await this.request(`/v1/reference-data/locations/cities?${searchParams}`);
		if (!response.ok) {
			const error = await response.text();
			throw new Error(`City Search failed: ${error}`);
		}
		return response.json();
	}

	// ============================================================================
	// HOTEL APIs (4 APIs)
	// ============================================================================

	/**
	 * 20. Hotel List
	 * GET /v3/reference-data/locations/hotels/by-geocode
	 * GET /v3/reference-data/locations/hotels/by-city
	 */
	async searchHotelsByGeocode(params: {
		latitude: number;
		longitude: number;
		radius?: number;
		radiusUnit?: string;
		hotelSource?: string;
	}): Promise<any> {
		const searchParams = new URLSearchParams({
			latitude: String(params.latitude),
			longitude: String(params.longitude),
		});
		if (params.radius) searchParams.append("radius", String(params.radius));
		if (params.radiusUnit) searchParams.append("radiusUnit", params.radiusUnit);
		if (params.hotelSource) searchParams.append("hotelSource", params.hotelSource);

		const response = await this.request(`/v3/reference-data/locations/hotels/by-geocode?${searchParams}`);
		if (!response.ok) {
			const error = await response.text();
			throw new Error(`Hotel List failed: ${error}`);
		}
		return response.json();
	}

	async searchHotelsByCity(params: {
		cityCode: string;
		hotelSource?: string;
	}): Promise<any> {
		const searchParams = new URLSearchParams({ cityCode: params.cityCode });
		if (params.hotelSource) searchParams.append("hotelSource", params.hotelSource);

		const response = await this.request(`/v3/reference-data/locations/hotels/by-city?${searchParams}`);
		if (!response.ok) {
			const error = await response.text();
			throw new Error(`Hotel List by City failed: ${error}`);
		}
		return response.json();
	}

	/**
	 * 21. Hotel Search
	 * GET /v3/shopping/hotel-offers
	 */
	async searchHotelOffers(params: {
		hotelIds?: string;
		cityCode?: string;
		latitude?: number;
		longitude?: number;
		radius?: number;
		radiusUnit?: string;
		checkInDate?: string;
		checkOutDate?: string;
		adults?: number;
		roomQuantity?: number;
		priceRange?: string;
		currency?: string;
		paymentPolicy?: string;
		boardType?: string;
		view?: string;
	}): Promise<any> {
		const searchParams = new URLSearchParams();
		if (params.hotelIds) searchParams.append("hotelIds", params.hotelIds);
		if (params.cityCode) searchParams.append("cityCode", params.cityCode);
		if (params.latitude) searchParams.append("latitude", String(params.latitude));
		if (params.longitude) searchParams.append("longitude", String(params.longitude));
		if (params.radius) searchParams.append("radius", String(params.radius));
		if (params.radiusUnit) searchParams.append("radiusUnit", params.radiusUnit);
		if (params.checkInDate) searchParams.append("checkInDate", params.checkInDate);
		if (params.checkOutDate) searchParams.append("checkOutDate", params.checkOutDate);
		if (params.adults) searchParams.append("adults", String(params.adults));
		if (params.roomQuantity) searchParams.append("roomQuantity", String(params.roomQuantity));
		if (params.priceRange) searchParams.append("priceRange", params.priceRange);
		if (params.currency) searchParams.append("currency", params.currency);
		if (params.paymentPolicy) searchParams.append("paymentPolicy", params.paymentPolicy);
		if (params.boardType) searchParams.append("boardType", params.boardType);
		if (params.view) searchParams.append("view", params.view);

		const response = await this.request(`/v3/shopping/hotel-offers?${searchParams}`);
		if (!response.ok) {
			const error = await response.text();
			throw new Error(`Hotel Search failed: ${error}`);
		}
		return response.json();
	}

	/**
	 * 22. Hotel Name Autocomplete
	 * GET /v1/reference-data/locations/hotels/by-keyword
	 */
	async searchHotelNameAutocomplete(params: {
		keyword: string;
		hotelSource?: string;
		max?: number;
	}): Promise<any> {
		const searchParams = new URLSearchParams({ keyword: params.keyword });
		if (params.hotelSource) searchParams.append("hotelSource", params.hotelSource);
		if (params.max) searchParams.append("max", String(params.max));

		const response = await this.request(`/v1/reference-data/locations/hotels/by-keyword?${searchParams}`);
		if (!response.ok) {
			const error = await response.text();
			throw new Error(`Hotel Name Autocomplete failed: ${error}`);
		}
		return response.json();
	}

	/**
	 * 23. Hotel Ratings
	 * GET /v2/e-reputation/hotel-sentiments
	 */
	async getHotelRatings(params: {
		hotelIds: string;
	}): Promise<any> {
		const searchParams = new URLSearchParams({ hotelIds: params.hotelIds });

		const response = await this.request(`/v2/e-reputation/hotel-sentiments?${searchParams}`);
		if (!response.ok) {
			const error = await response.text();
			throw new Error(`Hotel Ratings failed: ${error}`);
		}
		return response.json();
	}

	// ============================================================================
	// DESTINATION EXPERIENCE APIs (2 APIs)
	// ============================================================================

	/**
	 * 24. City Search (already implemented above as part of Flight APIs)
	 * This is the same as #19 above
	 */

	/**
	 * 25. Tours and Activities
	 * GET /v1/shopping/activities
	 */
	async searchActivities(params: {
		latitude?: number;
		longitude?: number;
		radius?: number;
		category?: string;
		subcategory?: string;
		currency?: string;
		lang?: string;
	}): Promise<any> {
		const searchParams = new URLSearchParams();
		if (params.latitude) searchParams.append("latitude", String(params.latitude));
		if (params.longitude) searchParams.append("longitude", String(params.longitude));
		if (params.radius) searchParams.append("radius", String(params.radius));
		if (params.category) searchParams.append("category", params.category);
		if (params.subcategory) searchParams.append("subcategory", params.subcategory);
		if (params.currency) searchParams.append("currency", params.currency);
		if (params.lang) searchParams.append("lang", params.lang);

		const response = await this.request(`/v1/shopping/activities?${searchParams}`);
		if (!response.ok) {
			const error = await response.text();
			throw new Error(`Tours and Activities failed: ${error}`);
		}
		return response.json();
	}

	/**
	 * 26. Tours and Activities by ID
	 * GET /v1/shopping/activities/{activityId}
	 */
	async getActivity(activityId: string, params?: { lang?: string }): Promise<any> {
		const searchParams = new URLSearchParams();
		if (params?.lang) searchParams.append("lang", params.lang);

		const url = `/v1/shopping/activities/${activityId}${searchParams.toString() ? `?${searchParams}` : ""}`;
		const response = await this.request(url);
		if (!response.ok) {
			const error = await response.text();
			throw new Error(`Get Activity failed: ${error}`);
		}
		return response.json();
	}

	// ============================================================================
	// TRANSFER/TRANSPORTATION APIs (1 API)
	// ============================================================================

	/**
	 * 27. Transfer Search
	 * GET /v1/shopping/transfer-offers
	 */
	async searchTransfers(params: {
		originLocationCode: string;
		destinationLocationCode: string;
		departureDateTime: string;
		adults?: number;
		children?: number;
		vehicleType?: string;
	}): Promise<any> {
		const searchParams = new URLSearchParams({
			originLocationCode: params.originLocationCode,
			destinationLocationCode: params.destinationLocationCode,
			departureDateTime: params.departureDateTime,
		});
		if (params.adults) searchParams.append("adults", String(params.adults));
		if (params.children) searchParams.append("children", String(params.children));
		if (params.vehicleType) searchParams.append("vehicleType", params.vehicleType);

		const response = await this.request(`/v1/shopping/transfer-offers?${searchParams}`);
		if (!response.ok) {
			const error = await response.text();
			throw new Error(`Transfer Search failed: ${error}`);
		}
		return response.json();
	}

	// ============================================================================
	// OTHER APIs (1 API)
	// ============================================================================

	/**
	 * 28. Travel Recommendations
	 * GET /v1/reference-data/recommended-locations
	 */
	async getRecommendedLocations(params: {
		cityCodes?: string;
		travelerCountryCode?: string;
	}): Promise<any> {
		const searchParams = new URLSearchParams();
		if (params.cityCodes) searchParams.append("cityCodes", params.cityCodes);
		if (params.travelerCountryCode) searchParams.append("travelerCountryCode", params.travelerCountryCode);

		const response = await this.request(`/v1/reference-data/recommended-locations?${searchParams}`);
		if (!response.ok) {
			const error = await response.text();
			throw new Error(`Travel Recommendations failed: ${error}`);
		}
		return response.json();
	}
}
