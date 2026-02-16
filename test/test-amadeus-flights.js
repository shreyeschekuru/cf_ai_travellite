/**
 * Amadeus Flight Search Test Script
 * 
 * Tests the searchFlights method via RPC to verify Amadeus API integration
 * 
 * Usage:
 *   npm run test:amadeus [sessionName]
 *   OR
 *   node test/test-amadeus-flights.js [sessionName]
 * 
 * Example:
 *   npm run test:amadeus test-session
 *   OR
 *   node test/test-amadeus-flights.js test-session
 * 
 * Prerequisites:
 *   - AMADEUS_API_KEY and AMADEUS_API_SECRET must be set in .dev.vars or environment
 *   - Worker must be running (npm run dev)
 */

const http = require('http');

// Get session name from command line or use default
const sessionName = process.argv[2] || 'test-session';
const baseUrl = 'http://localhost:8787';
const rpcEndpoint = `${baseUrl}/agents/TravelAgent/${sessionName}/rpc`;

console.log('Testing Amadeus Flight Search API');
console.log(`RPC Endpoint: ${rpcEndpoint}`);
console.log(`Session: ${sessionName}\n`);

// Track test results
let testCount = 0;
let passCount = 0;
let failCount = 0;

/**
 * Make an RPC call to searchFlights
 */
function testFlightSearch(description, params) {
	return new Promise((resolve, reject) => {
		testCount++;
		
		const rpcData = {
			type: 'rpc',
			id: `test-${testCount}-${Date.now()}`,
			method: 'searchFlights',
			args: [params],
		};

		const postData = JSON.stringify(rpcData);

		const options = {
			hostname: 'localhost',
			port: 8787,
			path: `/agents/TravelAgent/${sessionName}/rpc`,
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Content-Length': Buffer.byteLength(postData),
			},
		};

		console.log(`\nTest #${testCount}: ${description}`);
		console.log(`   Parameters:`);
		console.log(`   ${JSON.stringify(params, null, 2).split('\n').map(l => '   ' + l).join('\n')}`);

		const req = http.request(options, (res) => {
			let data = '';

			res.on('data', (chunk) => {
				data += chunk;
			});

			res.on('end', () => {
				try {
					const response = JSON.parse(data);
					
					console.log(`   Status: ${res.statusCode}`);
					
					if (response.success) {
						const result = response.result;
						
						// FAIL if we get the placeholder message (API wasn't called)
						if (result && result.message === "Flight search functionality to be implemented") {
							console.log(`   FAILED: API was not called - placeholder response detected`);
							console.log(`   This means searchFlights() is not actually calling the Amadeus API`);
							failCount++;
							reject(new Error('API was not called - placeholder response'));
							return;
						}
						
						// Check if result has flight data
						if (result && result.success) {
							console.log(`   Success: Flight search completed`);
							
							// Display flight results if available
							if (result.flights && Array.isArray(result.flights)) {
								if (result.flights.length === 0) {
									console.log(`   No flights found for this route/date`);
									console.log(`   (This may be normal - Amadeus test API has limited data)`);
								} else {
									console.log(`   Found ${result.flights.length} flight(s):`);
									result.flights.slice(0, 3).forEach((flight, idx) => {
										console.log(`   Flight ${idx + 1}:`);
										if (flight.itineraries && flight.itineraries[0]) {
											const segments = flight.itineraries[0].segments || [];
											if (segments.length > 0) {
												const first = segments[0];
												const last = segments[segments.length - 1];
												console.log(`      ${first.departure?.iataCode} → ${last.arrival?.iataCode}`);
												console.log(`      Departure: ${first.departure?.at || 'N/A'}`);
												console.log(`      Arrival: ${last.arrival?.at || 'N/A'}`);
											}
										}
										if (flight.price) {
											console.log(`      Price: ${flight.price.total || 'N/A'} ${flight.price.currency || 'USD'}`);
										}
									});
									if (result.flights.length > 3) {
										console.log(`   ... and ${result.flights.length - 3} more`);
									}
								}
							} else {
								console.log(`   WARNING: No flights array in response`);
								console.log(`   Result structure: ${JSON.stringify(result, null, 2).split('\n').slice(0, 10).map(l => '   ' + l).join('\n')}`);
							}
							
							passCount++;
							resolve(result);
						} else if (result && result.error) {
							console.log(`   Error: ${result.error}`);
							failCount++;
							reject(new Error(result.error));
						} else {
							console.log(`   Unexpected result format:`);
							console.log(`   ${JSON.stringify(result, null, 2).split('\n').map(l => '   ' + l).join('\n')}`);
							failCount++;
							reject(new Error('Unexpected result format'));
						}
					} else {
						console.log(`   Error: ${response.error || 'Unknown error'}`);
						failCount++;
						reject(new Error(response.error || 'Unknown error'));
					}
				} catch (error) {
					console.log(`   Parse Error: ${error.message}`);
					console.log(`   Raw Response: ${data}`);
					failCount++;
					reject(error);
				}
			});
		});

		req.on('error', (error) => {
			console.log(`   Request Error: ${error.message}`);
			failCount++;
			reject(error);
		});

		req.write(postData);
		req.end();
	});
}

/**
 * Get a future date in YYYY-MM-DD format
 * @param daysFromNow Number of days from today
 * @returns Date string in YYYY-MM-DD format
 */
function getFutureDate(daysFromNow) {
	const date = new Date();
	date.setDate(date.getDate() + daysFromNow);
	const year = date.getFullYear();
	const month = String(date.getMonth() + 1).padStart(2, '0');
	const day = String(date.getDate()).padStart(2, '0');
	return `${year}-${month}-${day}`;
}

/**
 * Run all tests
 */
async function runTests() {
	console.log('Starting Amadeus flight search tests...\n');
	
	// Generate future dates (30, 37, 45 days from now)
	const departureDate = getFutureDate(30);
	const returnDate = getFutureDate(37);
	const internationalDate = getFutureDate(45);
	
	console.log(`Using dates: Departure=${departureDate}, Return=${returnDate}, International=${internationalDate}\n`);

	try {
		// Test 1: One-way flight search
		await testFlightSearch(
			'One-way flight: NYC to LAX',
			{
				origin: 'NYC',
				destination: 'LAX',
				departureDate: departureDate,
				adults: 1
			}
		);
		
		// Wait a bit between requests
		await new Promise(resolve => setTimeout(resolve, 2000));

		// Test 2: Round-trip flight search
		await testFlightSearch(
			'Round-trip flight: NYC to LAX',
			{
				origin: 'NYC',
				destination: 'LAX',
				departureDate: departureDate,
				returnDate: returnDate,
				adults: 1
			}
		);
		
		await new Promise(resolve => setTimeout(resolve, 2000));

		// Test 3: International flight
		await testFlightSearch(
			'International flight: NYC to PAR',
			{
				origin: 'NYC',
				destination: 'PAR',
				departureDate: internationalDate,
				adults: 1
			}
		);
		
		await new Promise(resolve => setTimeout(resolve, 2000));

		// Test 4: Multiple passengers
		await testFlightSearch(
			'Multiple passengers: NYC to LAX (2 adults)',
			{
				origin: 'NYC',
				destination: 'LAX',
				departureDate: departureDate,
				adults: 2
			}
		);

	} catch (error) {
		console.error(`\nTest suite error: ${error.message}`);
	}

	// Print summary
	console.log('\n' + '='.repeat(60));
	console.log('Test Summary:');
	console.log(`   Total Tests: ${testCount}`);
	console.log(`   Passed: ${passCount}`);
	console.log(`   Failed: ${failCount}`);
	console.log(`   Success Rate: ${((passCount / testCount) * 100).toFixed(1)}%`);
	console.log('='.repeat(60) + '\n');
}

// Run tests
runTests().catch((error) => {
	console.error('Fatal error:', error);
	process.exit(1);
});

