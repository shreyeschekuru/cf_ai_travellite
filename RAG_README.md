# RAG (Retrieval-Augmented Generation) Implementation

This document describes the RAG implementation for the TravelLite application, which combines base travel knowledge with live-learned content from Amadeus API results.

## Overview

The RAG system has two components:

1. **Base RAG Files**: Pre-seeded travel knowledge from curated text files
2. **Live-Learned RAG**: Automatically ingested content from Amadeus API results

## Architecture

### Vectorize Index
- **Index Name**: `travellite-index`
- **Binding**: `VECTORIZE`
- **Embedding Model**: `@cf/baai/bge-base-en-v1.5`

### KV Namespace
- **Binding**: `KVNAMESPACE`
- **Purpose**: Deduplication tracking for ingested content

## Base RAG Files

### Location
All base RAG files are stored in the `RAG_files/` directory as `.txt` files.

### Seeding Base RAG Files

To seed the base RAG files into Vectorize:

1. **Start the Worker**:
   ```bash
   npm run dev
   ```

2. **Run the seeding script** (in a new terminal):
   ```bash
   npm run seed:rag
   ```

The script will:
- Read all `.txt` files from `RAG_files/` directory
- Generate embeddings for each file
- Upsert them into Vectorize with metadata
- Store ingestion status in KV to prevent duplicates

### File Format
Each RAG file should contain travel-related knowledge in plain text. The filename (without `.txt`) becomes the topic in metadata.

Example:
- `budget_travel_strategies.txt` → topic: "budget travel strategies"

## Live-Learned RAG

### How It Works

When the TravelAgent calls Amadeus APIs (flights, hotels, activities), the results are automatically:

1. **Normalized**: Extracted into structured format
2. **Summarized**: Converted into human-readable summaries
3. **Deduplicated**: Checked against KV to avoid duplicates
4. **Embedded**: Generated embeddings using Workers AI
5. **Ingested**: Upserted into Vectorize with metadata

### Metadata Structure

Each ingested item includes:
```typescript
{
  amadeusId: string;        // Unique Amadeus identifier
  city: string;            // City/location
  type: string;            // "hotel", "flight", "activity", etc.
  tags: string;            // Comma-separated tags
  createdAt: number;       // Timestamp
  source: "amadeus";       // Source identifier
  text: string;            // Summary text for retrieval
}
```

### Deduplication

Deduplication uses KV with keys like:
- `amadeus:hotel:{hotelId}`
- `amadeus:flight:{flightId}`
- `amadeus:activity:{activityId}`

If a key exists, the item is skipped to avoid duplicates.

## RAG Retrieval

### Query Process

When a user query requires RAG:

1. **Generate Query Embedding**: User query is embedded using Workers AI
2. **Query Vectorize**: Search with optional filters (e.g., by city)
3. **Format Context**: Top 5 results are formatted into context paragraphs
4. **Include in LLM Prompt**: Context is added to the system prompt

### Filtering

RAG queries can be filtered by:
- `city`: Match current trip destination
- `type`: Filter by content type
- `source`: Filter by source (base-rag-file vs amadeus)

## Usage in TravelAgent

### Automatic RAG Retrieval

RAG is automatically triggered when user queries contain keywords like:
- "recommend"
- "suggest"
- "what to do"
- "attractions"
- "places to visit"
- "activities"
- "things to see"

### Automatic RAG Ingestion

RAG ingestion happens automatically after Amadeus API calls:
- **Flights**: Top 5 flight results are ingested
- **Hotels**: Top 5 hotel results are ingested
- **Activities**: Top 5 activity results are ingested

## API Endpoints

### Seed RAG Files
```
POST /api/seed-rag
Content-Type: application/json

{
  "fileName": "budget_travel_strategies.txt",
  "content": "Full file content..."
}
```

Response:
```json
{
  "success": true,
  "id": "rag-budget-travel-strategies",
  "message": "File ingested successfully"
}
```

## Troubleshooting

### Embedding Generation Fails
- Check that Workers AI binding is configured
- Verify the embedding model `@cf/baai/bge-base-en-v1.5` is available
- Check Worker logs for detailed error messages

### Vectorize Query Returns No Results
- Verify Vectorize index exists and is bound correctly
- Check that content has been ingested (use KV to verify)
- Try querying without filters first

### Duplicate Content
- Check KV namespace for existing keys
- Verify deduplication logic is working
- Clear KV keys if needed: `wrangler kv:key delete --namespace-id=YOUR_ID rag:file:FILENAME`

## Best Practices

1. **Keep Summaries Concise**: Summaries should be 50-200 words for best retrieval
2. **Use Descriptive Tags**: Tags help with filtering and organization
3. **Regular Cleanup**: Periodically review and remove outdated content
4. **Monitor Index Size**: Vectorize has limits - monitor usage
5. **Test Queries**: Regularly test RAG retrieval to ensure quality

## Future Enhancements

- [ ] Support for chunking large RAG files
- [ ] Automatic content expiration/cleanup
- [ ] RAG quality scoring and filtering
- [ ] Multi-language support
- [ ] RAG analytics and monitoring


