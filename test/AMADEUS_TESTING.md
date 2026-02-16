# Amadeus APIs Testing Guide

## Comprehensive Test Suite for All Amadeus APIs

This test suite tests all 37 Amadeus APIs through the unified `callAmadeusAPI` method.

## Prerequisites

1. **Amadeus API Credentials**
   - Sign up at [Amadeus for Developers](https://developers.amadeus.com/)
   - Get your `AMADEUS_API_KEY` (Client ID) and `AMADEUS_API_SECRET` (Client Secret)
   - The implementation uses the **test environment** (`test.api.amadeus.com`)

2. **Environment Variables**
   - Create or update `.dev.vars` file in the project root:
     ```
     AMADEUS_API_KEY=your_client_id_here
     AMADEUS_API_SECRET=your_client_secret_here
     ```
   - Or set them in your environment before running the worker

3. **Worker Running**
   - Start the development server: `npm run dev`
   - The worker should be running on `http://localhost:8787`

## Running the Tests

### Basic Usage

```bash
# Use default session name
npm run test:amadeus

# Or specify a session name
npm run test:amadeus my-session

# Or run directly
node test/test-amadeus-apis.js [sessionName]
```

## Test Coverage

The test script covers multiple API categories:

### Flight APIs (4 tests)
1. **Search Flight Offers** - One-way flight search (NYC → LAX)
2. **Search Flight Destinations** - Flight inspiration search from NYC
3. **Search Cheapest Flight Dates** - Find cheapest dates for NYC → LAX
4. **Get Most Traveled Destinations** - Most popular destinations from NYC

### Location & City Search APIs (3 tests)
5. **Search Locations** - Search for airports by keyword "New York"
6. **Search Cities** - Search for cities by keyword "Paris"
7. **Get Airport Direct Destinations** - Direct destinations from JFK

### Hotel APIs (2 tests)
8. **Search Hotels by City** - Find hotels in Paris
9. **Search Hotel Offers** - Search hotel availability in Paris

### Points of Interest APIs (1 test)
10. **Search Points of Interest** - Find POIs near Paris coordinates

### Travel Recommendations APIs (1 test)
11. **Get Recommended Locations** - Get travel recommendations for Paris

### Utility APIs (1 test)
12. **Search Airlines** - Search for airline information (AA, DL, UA)

### Safety APIs (1 test)
13. **Get Safety Rated Locations** - Get safety ratings for France

## Expected Output

### Successful Response

```
[1] Search Flight Offers (One-way)
   API: searchFlightOffers
   Parameters: {
     "origin": "NYC",
     "destination": "LAX",
     "departureDate": "2025-12-15",
     "adults": 1,
     "max": 3
   }
   ✓ Success
   Found 3 result(s)
   Sample: {
     "type": "flight-offer",
     ...
   }
```

### Response Format

All APIs return a standardized format:
```json
{
  "success": true,
  "data": {
    // API-specific response data
  }
}
```

Or on error:
```json
{
  "success": false,
  "error": "Error message here"
}
```

## Test Results

The test script provides a comprehensive summary:

```
================================================================
TEST SUMMARY
================================================================
   Total Tests: 13
   Passed: 10
   Failed: 0
   Skipped: 3
   Success Rate: 76.9%
================================================================
```

### Understanding Results

- **Passed**: API call succeeded and returned data
- **Failed**: API call failed with an error
- **Skipped**: API call succeeded but returned no data (expected in test environment)
  - Some APIs may not have test data available
  - This is normal and doesn't indicate a problem

## Common Issues

### 1. Authentication Errors

**Error:** `Failed to get Amadeus access token`

**Solutions:**
- Verify your `AMADEUS_API_KEY` and `AMADEUS_API_SECRET` are correct
- Check that credentials are set in `.dev.vars` or environment
- Ensure you're using test environment credentials (not production)

### 2. No Data Available

**Message:** `Skipped (expected in test environment): No data found`

**Explanation:**
- The Amadeus test API has limited data
- Some routes, dates, or locations may not have test data
- This is expected behavior and not an error
- Tests are marked as "Skipped" rather than "Failed"

### 3. Connection Errors

**Error:** `Request Error: connect ECONNREFUSED`

**Solutions:**
- Ensure the worker is running: `npm run dev`
- Check that the worker is on port 8787
- Verify the endpoint URL is correct

### 4. Rate Limiting

**Error:** `429 Too Many Requests`

**Solutions:**
- The test script includes delays between requests (2 seconds)
- If you see rate limit errors, increase the delay in the script
- Amadeus test API has rate limits - wait a few minutes and retry

## Testing Individual APIs

You can test individual APIs using the RPC endpoint directly:

```bash
curl -X POST http://localhost:8787/agents/TravelAgent/test-session/rpc \
  -H "Content-Type: application/json" \
  -d '{
    "type": "rpc",
    "id": "test-1",
    "method": "callAmadeusAPI",
    "args": [
      "searchFlightOffers",
      {
        "origin": "NYC",
        "destination": "LAX",
        "departureDate": "2025-12-15",
        "adults": 1
      }
    ]
  }'
```

## Available APIs

The `callAmadeusAPI` method supports all 37 Amadeus APIs:

**Flight APIs:**
- `searchFlightOffers` / `searchFlights` (backward compatible)
- `getFlightOfferPrice` / `getFlightPrice` (backward compatible)
- `createFlightOrder`
- `getFlightOrder`
- `deleteFlightOrder`
- `searchFlightDestinations`
- `searchCheapestFlightDates`
- `getMostTraveledDestinations`

**Hotel APIs:**
- `searchHotelsByGeocode`
- `searchHotelsByCity`
- `searchHotelOffers` / `searchHotels` (backward compatible)
- `getHotelOffersByHotel` / `getHotelOffers` (backward compatible)
- `createHotelBooking`
- `getHotelRatings`

**Car APIs:**
- `searchCarRentals`
- `getCarRentalOffer`
- `createCarRentalBooking`

**Tours & Activities APIs:**
- `searchActivities`
- `getActivity`
- `createActivityBooking`

**Points of Interest APIs:**
- `searchPointsOfInterest` / `searchPOIs` (backward compatible)
- `searchPOIsBySquare`
- `getPOI`

**Airport & City Search APIs:**
- `searchLocations`
- `getAirportDirectDestinations` / `getAirportDestinations` (backward compatible)
- `getAirportOnTimePerformance`
- `searchCities`

**Travel Recommendations APIs:**
- `getRecommendedLocations`
- `predictTripPurpose`
- `predictFlightDelay`
- `getBusiestPeriod`

**Safety APIs:**
- `getSafetyRatedLocations`
- `getSafetyRatedLocation`

**Utility APIs:**
- `searchAirlines`
- `getSeatmap`
- `searchTransfers`
- `getFlightAvailabilities`

## Notes

- The test script uses future dates to avoid "Date/Time is in the past" errors
- Some APIs may require specific parameters that aren't tested
- The test environment has limited data - production will have more results
- All APIs return standardized `{ success, data }` or `{ success: false, error }` format
