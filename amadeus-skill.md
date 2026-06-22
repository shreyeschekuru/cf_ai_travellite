# Amadeus API Developer Skill

A comprehensive guide for building travel applications with Amadeus for Developers APIs.

---

## Overview

[Amadeus for Developers](https://developers.amadeus.com/) provides REST/JSON APIs for:
- **Flights**: Search, pricing, availability, booking
- **Hotels**: Search, offers, booking
- **Activities & POI**: Tours, attractions by location
- **Transfers**: Ground transportation search and booking
- **Reference Data**: Airports, airlines, locations
- **Analytics**: Pricing trends, delay predictions, traffic analysis

The official Node.js SDK (`amadeus` npm package) handles OAuth2 authentication, pagination, and error handling automatically.

---

## Getting Started

### Installation

```bash
npm install amadeus
```

### Registration & Credentials

1. Register at [developers.amadeus.com](https://developers.amadeus.com/)
2. Create an application to get `Client ID` and `Client Secret`
3. Store in `.dev.vars` or environment:
   ```
   AMADEUS_CLIENT_ID=your_client_id
   AMADEUS_CLIENT_SECRET=your_client_secret
   ```

### Quick Start

```javascript
const Amadeus = require('amadeus');

const amadeus = new Amadeus({
  clientId: process.env.AMADEUS_CLIENT_ID,
  clientSecret: process.env.AMADEUS_CLIENT_SECRET,
  hostname: 'test' // sandbox for development, 'production' for live
});

// Example: Search flights
const flights = await amadeus.shopping.flightOffersSearch.get({
  originLocationCode: 'NYC',
  destinationLocationCode: 'LAX',
  departureDate: '2026-08-01'
});
```

---

## Authentication & Configuration

### Client Options

```javascript
const amadeus = new Amadeus({
  clientId: string,           // Required: OAuth2 client ID
  clientSecret: string,       // Required: OAuth2 client secret
  hostname: string,           // 'test' (sandbox) or 'production'
  logLevel: string,          // 'debug', 'warn' (default), 'silent'
  ssl: boolean,              // true (default) or false
  port: number,              // 443 (default)
  customAppId: string,       // Custom User-Agent identifier
  customAppVersion: string   // Custom app version
});
```

### Token Management

The SDK handles OAuth2 automatically:
- Tokens expire in ~30 minutes
- SDK caches and refreshes automatically
- No manual token management needed

**In production**, consider logging token lifecycle:
```javascript
amadeus.on('refresh', () => console.log('Token refreshed'));
amadeus.on('networkError', (err) => console.error('Network error:', err));
```

---

## Core Concepts

### Request/Response Pattern

All methods return a **Promise** with a response object:

```javascript
const response = await amadeus.shopping.flightOffersSearch.get({...});

// Response structure:
response.statusCode       // HTTP status (200, 404, etc.)
response.body            // Raw response body (string)
response.result          // Parsed JSON object
response.data            // Shorthand: response.result.data
response.parsed          // Boolean: JSON parsed successfully
response.request         // Original Request object
```

### Pagination

Multi-page results support built-in pagination:

```javascript
const firstPage = await amadeus.referenceData.locations.get({
  keyword: 'london',
  subType: 'AIRPORT,CITY'
});

// Navigate pages
const nextPage = await amadeus.next(firstPage);
const prevPage = await amadeus.previous(firstPage);
const lastPage = amadeus.last(firstPage);
const firstPageAgain = amadeus.first(firstPage);
```

---

## Main API Categories

### Flight Offers

**Search flights** — Find available flights between two cities.

```javascript
// One-way flight
const flights = await amadeus.shopping.flightOffersSearch.get({
  originLocationCode: 'NYC',
  destinationLocationCode: 'MIA',
  departureDate: '2026-08-15',
  adults: 1
});

// Round-trip with multiple passengers
const roundTrip = await amadeus.shopping.flightOffersSearch.get({
  originLocationCode: 'LAX',
  destinationLocationCode: 'JFK',
  departureDate: '2026-09-01',
  returnDate: '2026-09-10',
  adults: 2,
  children: 1,
  infants: 0,
  travelClass: 'BUSINESS',
  nonStop: true
});
```

**Key parameters**:
- `originLocationCode`, `destinationLocationCode` — IATA airport codes
- `departureDate` — ISO 8601 (YYYY-MM-DD)
- `returnDate` — Optional; omit for one-way
- `adults`, `children`, `infants` — Passenger counts
- `travelClass` — ECONOMY, PREMIUM_ECONOMY, BUSINESS, FIRST
- `nonStop` — Boolean; true filters to non-stop flights only
- `max` — Max results (default 250)

**Understand the response**:
```javascript
// Structure: { data: [ { id, type, source, instantTicketingRequired, nonHomogeneous, ... }, ... ], dictionaries: {...} }
const offer = flights.data[0];
offer.id                    // Unique offer ID
offer.source                // 'GDS'
offer.instantTicketingRequired // true/false
offer.disablePricing        // true if price not available
offer.nonHomogeneous        // true if mixed airline journey
offer.oneWay                // true if one-way
offer.lastTicketingDate     // Deadline to book
offer.numberOfBookableSeats // Available seats at this price
offer.itineraries           // Array of flight segments
offer.price                 // { total, base, fee, grandTotal, currency }
offer.pricingOptions        // { fareType, includedCheckedBagsOnly: boolean }
offer.validatingAirlineCodes // Array of airline codes
offer.travelerPricings      // Passenger breakdown: [ { travelerId, fareDetailsBySegment, price } ]
```

### Hotel Offers

**Search hotels** — Find available accommodations.

```javascript
// Search by city code
const hotels = await amadeus.shopping.hotelOffersSearch.get({
  cityCode: 'PAR',  // Paris
  checkInDate: '2026-08-01',
  checkOutDate: '2026-08-05',
  adults: 2,
  roomQuantity: 1
});

// Search by coordinates (radius)
const nearbyHotels = await amadeus.shopping.hotelOffersSearch.get({
  latitude: 48.8566,
  longitude: 2.3522,
  radius: 5,  // 5 km radius
  radiusUnit: 'KM',
  checkInDate: '2026-08-01',
  checkOutDate: '2026-08-05',
  adults: 2
});
```

**Key parameters**:
- `cityCode` OR (`latitude` + `longitude`) — Location identifier
- `checkInDate`, `checkOutDate` — ISO 8601 (YYYY-MM-DD)
- `adults`, `children` — Occupancy
- `roomQuantity` — Number of rooms
- `radius` — Search radius (optional with coordinates)
- `radiusUnit` — KM or MILE

### Activities & Attractions

**Search activities** — Find tours and attractions by location.

```javascript
const activities = await amadeus.shopping.activities.get({
  latitude: 48.8566,   // Paris
  longitude: 2.3522,
  radius: 15  // 15 km radius
});

// Get activity details
const activity = await amadeus.shopping.activity(activityId).get();
```

### Reference Data

**Locations** — Search for airports, cities, POIs.

```javascript
// Airport/city search
const locations = await amadeus.referenceData.locations.get({
  keyword: 'paris',
  subType: 'AIRPORT,CITY'
});

// Nearby airports
const nearby = await amadeus.referenceData.locations.airports.get({
  latitude: 48.8566,
  longitude: 2.3522,
  radius: 30
});

// Airline lookup
const airlines = await amadeus.referenceData.airlines.get({
  airlineCodes: 'BA'  // British Airways
});
```

---

## Error Handling

### Error Types

The SDK throws a `ResponseError` object with:

```javascript
error.code          // Error code string
error.response      // Full response object (with statusCode, body, result)
error.description   // Error description from API
error.message       // Human-readable message
```

**Common error codes**:
- `AuthenticationError` — Invalid credentials
- `NetworkError` — Network failure or timeout
- `NotFoundError` — Resource not found (404)
- `BadRequestError` — Invalid parameters (400)
- `ServerError` — API server error (5xx)
- `ParserError` — Failed to parse response JSON
- `UnknownError` — Unexpected error

### Basic Error Handling

```javascript
try {
  const flights = await amadeus.shopping.flightOffersSearch.get({
    originLocationCode: 'NYC',
    destinationLocationCode: 'LAX',
    departureDate: '2026-08-01'
  });
  return flights.data;
} catch (error) {
  console.error('API Error:', error.code, error.message);
  
  if (error.code === 'AuthenticationError') {
    // Re-check credentials
    throw new Error('Invalid Amadeus credentials');
  } else if (error.code === 'BadRequestError') {
    // Invalid parameters
    console.error('Invalid request:', error.response.result);
  } else if (error.code === 'NetworkError') {
    // Network failure — retry with backoff
    throw new Error('Network timeout; retry later');
  } else {
    throw error;
  }
}
```

### Retry Logic (with exponential backoff)

```javascript
async function retryWithBackoff(fn, maxRetries = 3, baseDelayMs = 100) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (error.code === 'NetworkError' && attempt < maxRetries - 1) {
        const delayMs = baseDelayMs * Math.pow(2, attempt);
        console.log(`Retry ${attempt + 1} after ${delayMs}ms`);
        await new Promise(r => setTimeout(r, delayMs));
      } else {
        throw error;
      }
    }
  }
}

// Usage
const flights = await retryWithBackoff(() =>
  amadeus.shopping.flightOffersSearch.get({...})
);
```

### Handling Partial Data

Some responses may include partial or degraded data:

```javascript
const flights = await amadeus.shopping.flightOffersSearch.get({...});

// Check if pricing is available
if (flights.data[0].disablePricing) {
  console.warn('Pricing not available for this offer');
}

// Check seat availability
if (flights.data[0].numberOfBookableSeats === 0) {
  console.warn('No seats available at this price');
}

// Verify all required fields exist
const offer = flights.data[0];
if (!offer.price || !offer.itineraries) {
  console.warn('Incomplete offer data');
}
```

---

## Common Workflows

### Flight Search + Hotel Search (Multi-API)

```javascript
async function searchTrip(origin, destination, checkIn, checkOut, adults) {
  try {
    // Search flights in parallel
    const [flights, hotels] = await Promise.all([
      amadeus.shopping.flightOffersSearch.get({
        originLocationCode: origin,
        destinationLocationCode: destination,
        departureDate: checkIn,
        returnDate: checkOut,
        adults: adults
      }),
      // For hotels, need city code or coordinates
      // This example assumes destination is a city code
      amadeus.shopping.hotelOffersSearch.get({
        cityCode: destination,
        checkInDate: checkIn,
        checkOutDate: checkOut,
        adults: adults,
        roomQuantity: 1
      })
    ]);

    return {
      flights: flights.data || [],
      hotels: hotels.data || [],
      errors: []
    };
  } catch (error) {
    console.error('Trip search failed:', error.code);
    throw error;
  }
}
```

### Pagination through Results

```javascript
async function getAllDestinations(keyword) {
  const results = [];
  let page = await amadeus.referenceData.locations.get({
    keyword,
    subType: 'AIRPORT,CITY'
  });

  results.push(...page.data);

  // Iterate through pages
  while (amadeus.next(page)) {
    page = await amadeus.next(page);
    results.push(...page.data);
  }

  return results;
}
```

---

## Production Patterns

### Caching Responses

```javascript
const cache = new Map();
const CACHE_TTL_MS = 3600000; // 1 hour

async function getCachedFlights(origin, destination, date) {
  const cacheKey = `${origin}-${destination}-${date}`;
  const cached = cache.get(cacheKey);

  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return cached.data;
  }

  const flights = await amadeus.shopping.flightOffersSearch.get({
    originLocationCode: origin,
    destinationLocationCode: destination,
    departureDate: date
  });

  cache.set(cacheKey, {
    data: flights.data,
    timestamp: Date.now()
  });

  return flights.data;
}
```

### Rate Limiting

Amadeus has rate limits. Implement throttling:

```javascript
const pLimit = require('p-limit');
const limit = pLimit(3); // Max 3 concurrent requests

async function batchSearch(routes) {
  return Promise.all(
    routes.map(route =>
      limit(() =>
        amadeus.shopping.flightOffersSearch.get(route)
      )
    )
  );
}
```

### Timeouts

```javascript
function withTimeout(promise, timeoutMs) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Request timeout')), timeoutMs)
    )
  ]);
}

// Usage
const flights = await withTimeout(
  amadeus.shopping.flightOffersSearch.get({...}),
  5000 // 5 second timeout
);
```

### Logging & Observability

```javascript
class AmadeusLogger {
  logRequest(method, endpoint, params) {
    console.log(`[AMADEUS] ${method} ${endpoint}`, {
      params,
      timestamp: new Date().toISOString()
    });
  }

  logResponse(endpoint, statusCode, duration) {
    console.log(`[AMADEUS] Response from ${endpoint}`, {
      statusCode,
      durationMs: duration,
      timestamp: new Date().toISOString()
    });
  }

  logError(error, endpoint) {
    console.error(`[AMADEUS] Error on ${endpoint}`, {
      code: error.code,
      message: error.message,
      statusCode: error.response?.statusCode
    });
  }
}
```

---

## Testing

### Sandbox Environment

Always use `hostname: 'test'` for development:

```javascript
const amadeus = new Amadeus({
  clientId: process.env.AMADEUS_CLIENT_ID,
  clientSecret: process.env.AMADEUS_CLIENT_SECRET,
  hostname: 'test'  // Sandbox with test data
});
```

### Postman Collection

Amadeus provides a [Postman Collection](https://developers.amadeus.com/self-service) for testing endpoints directly.

### Mock Responses for Unit Tests

```javascript
// Mock the Amadeus client for testing
const mockFlights = {
  data: [
    {
      id: '1',
      source: 'GDS',
      instantTicketingRequired: false,
      nonHomogeneous: false,
      oneWay: false,
      lastTicketingDate: '2026-07-15',
      numberOfBookableSeats: 5,
      itineraries: [{...}],
      price: {
        total: '500.00',
        base: '400.00',
        fee: '0.00',
        grandTotal: '500.00',
        currency: 'USD'
      },
      pricingOptions: {
        fareType: ['PUBLISHED'],
        includedCheckedBagsOnly: true
      }
    }
  ]
};

// Use in tests
jest.mock('amadeus', () => ({
  shopping: {
    flightOffersSearch: {
      get: jest.fn().mockResolvedValue(mockFlights)
    }
  }
}));
```

---

## Edge Cases & Gotchas

### No Results

Always handle empty data arrays:

```javascript
const flights = await amadeus.shopping.flightOffersSearch.get({...});
if (!flights.data || flights.data.length === 0) {
  return { error: 'No flights found for these parameters' };
}
```

### Missing Price Data

Some offers may have `disablePricing: true`:

```javascript
const cheapest = flights.data.find(f => !f.disablePricing);
if (!cheapest) {
  return { error: 'Pricing not available' };
}
```

### Simultaneous Bookings

When multiple users search the same flight, `numberOfBookableSeats` may drop to zero:

```javascript
// Re-check availability before booking
const current = await amadeus.shopping.flightOffersSearch.get({...});
const updated = current.data.find(f => f.id === originalOffer.id);
if (updated.numberOfBookableSeats === 0) {
  return { error: 'Flight is now sold out' };
}
```

### Date Validation

Dates must be in ISO 8601 format and future-dated:

```javascript
const tomorrow = new Date();
tomorrow.setDate(tomorrow.getDate() + 1);
const dateStr = tomorrow.toISOString().split('T')[0]; // YYYY-MM-DD

try {
  const flights = await amadeus.shopping.flightOffersSearch.get({
    departureDate: dateStr
  });
} catch (error) {
  if (error.code === 'BadRequestError') {
    console.error('Invalid date format or past date');
  }
}
```

### Rate Limiting (429 Too Many Requests)

```javascript
try {
  const flights = await amadeus.shopping.flightOffersSearch.get({...});
} catch (error) {
  if (error.response?.statusCode === 429) {
    console.log('Rate limited. Wait and retry.');
    await new Promise(r => setTimeout(r, 60000)); // 1 minute
  }
}
```

---

## References

- **Official SDK**: [amadeus4dev/amadeus-node](https://github.com/amadeus4dev/amadeus-node)
- **API Documentation**: [developers.amadeus.com/self-service/apis-docs](https://developers.amadeus.com/self-service/apis-docs)
- **Developer Portal**: [developers.amadeus.com](https://developers.amadeus.com/)
- **Node.js SDK Reference**: [amadeus4dev.github.io/amadeus-node](https://amadeus4dev.github.io/amadeus-node/)
- **OpenAPI Spec**: Available in developer portal for each API

---

## Key Takeaways

✅ **Always use the official Node.js SDK** — handles OAuth2 and pagination automatically  
✅ **Implement retry logic with exponential backoff** — network failures are transient  
✅ **Validate and handle partial responses** — pricing, availability, and seat counts can be missing  
✅ **Use sandbox (`hostname: 'test'`) for development** — switch to production only when ready  
✅ **Understand the response structure** — `data`, `result`, `statusCode` are different properties  
✅ **Handle rate limits gracefully** — respect 429 responses with backoff  
✅ **Cache responses when appropriate** — reduce API calls and improve latency  
✅ **Implement comprehensive error handling** — distinguish auth, network, and validation errors
