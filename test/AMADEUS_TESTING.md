# Amadeus Flight Search API Testing Guide

## We used the Flight Search API to test connection with Amadeus

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
node test/test-amadeus-flights.js [sessionName]
```

## Test Cases

The test script runs the following scenarios:

1. **One-way Flight Search**
   - NYC → LAX
   - Departure: 2025-12-01
   - 1 adult

2. **Round-trip Flight Search**
   - NYC → LAX
   - Departure: 2025-12-01
   - Return: 2025-12-08
   - 1 adult

3. **International Flight**
   - NYC → PAR (Paris)
   - Departure: 2025-12-15
   - 1 adult

4. **Multiple Passengers**
   - NYC → LAX
   - Departure: 2025-12-01
   - 2 adults

## Expected Output

### Successful Response

```
Test #1: One-way flight: NYC to LAX
   Parameters:
   {
     "origin": "NYC",
     "destination": "LAX",
     "departureDate": "2025-12-01",
     "adults": 1
   }
   Status: 200
   Success: Flight search completed
   Found 5 flight(s):
   Flight 1:
      NYC → LAX
      Departure: 2025-12-01T08:00:00
      Arrival: 2025-12-01T11:30:00
      Price: 350.00 USD
   ...
```

### Response Format

The `searchFlights` method returns:
```json
{
  "success": true,
  "message": "Flight search completed",
  "flights": [
    {
      "itineraries": [
        {
          "segments": [
            {
              "departure": {
                "iataCode": "NYC",
                "at": "2025-12-01T08:00:00"
              },
              "arrival": {
                "iataCode": "LAX",
                "at": "2025-12-01T11:30:00"
              },
              "carrierCode": "AA",
              "number": "123"
            }
          ]
        }
      ],
      "price": {
        "total": "350.00",
        "currency": "USD"
      }
    }
  ],
  "params": { ... }
}
```

## Common Issues

### 1. Authentication Errors

**Error:** `Failed to get Amadeus access token`

**Solutions:**
- Verify your `AMADEUS_API_KEY` and `AMADEUS_API_SECRET` are correct
- Check that credentials are set in `.dev.vars` or environment
- Ensure you're using test environment credentials (not production)

### 2. No Flights Found

**Possible Reasons:**
- Date is too far in the future (Amadeus test API may have limited data)
- Airport codes are invalid
- No flights available for the route/date

**Solutions:**
- Try dates within the next 6 months
- Use valid IATA airport codes (e.g., NYC, LAX, JFK, LHR, PAR)
- Try different routes

### 3. Connection Errors

**Error:** `Request Error: connect ECONNREFUSED`

**Solutions:**
- Ensure the worker is running: `npm run dev`
- Check that the worker is on port 8787
- Verify the endpoint URL is correct

### 4. Invalid Parameters

**Error:** `Amadeus API error: 400 Bad Request`

**Solutions:**
- Verify date format is `YYYY-MM-DD` (e.g., `2025-12-01`)
- Ensure airport codes are valid IATA codes
- Check that `adults` is a number (1-9)

## Testing via RPC Directly

You can also test using curl:

```bash
curl -X POST http://localhost:8787/agents/TravelAgent/test-session/rpc \
  -H "Content-Type: application/json" \
  -d '{
    "type": "rpc",
    "id": "test-1",
    "method": "searchFlights",
    "args": [{
      "origin": "NYC",
      "destination": "LAX",
      "departureDate": "2025-12-01",
      "adults": 1
    }]
  }'
```

## Testing via handleMessage

You can also trigger flight search through natural language:

```bash
# Via WebSocket (using test-websocket.js)
npm run test:ws

# Then send: "Search for flights from NYC to LAX on December 1st"
```

The agent will automatically detect flight-related keywords and call the `searchFlights` tool.

