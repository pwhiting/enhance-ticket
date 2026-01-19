# Vector Search Setup

## Overview
This repository contains a BookStack-backed KB indexing pipeline, hybrid retrieval (keyword + vector), and a ticket enrichment service that calls `gpt-5.2` to draft internal technician notes based on retrieved KB excerpts.

## Environment Variables

### Shared
| Variable | Default | Description |
| --- | --- | --- |
| `DB_HOST` | `127.0.0.1` | MySQL host |
| `DB_USER` | `bs_user` | MySQL user |
| `DB_PASSWORD` | (required) | MySQL password |
| `DB_NAME` | `bookstack` | MySQL database name |
| `OPENAI_API_KEY` | (required) | OpenAI API key |
| `EMBEDDING_MODEL` | `text-embedding-3-small` | Embedding model for chunking/indexing and queries |
| `VECTOR_EXPR` | `?` | Vector expression (use `VECTOR(?)` only with VECTOR-enabled MySQL) |

### Indexer
| Variable | Default | Description |
| --- | --- | --- |
| `CHUNK_TOKENS` | `500` | Target chunk size in tokens |
| `CHUNK_OVERLAP` | `75` | Overlap size in tokens |
| `EMBED_BATCH_SIZE` | `50` | Embedding batch size |

### Retrieval (Search)
| Variable | Default | Description |
| --- | --- | --- |
| `CANDIDATE_LIMIT` | `2000` | Max candidate chunks fetched before scoring |
| `KEYWORD_LIMIT` | `200` | Max pages from keyword prefilter |
| `TERM_LIMIT` | `20` | Max keyword terms extracted from ticket text |

### Enrichment Service
| Variable | Default | Description |
| --- | --- | --- |
| `LLM_MODEL` | `gpt-5.2` | LLM model for enrichment |
| `TOP_K` | `6` | Number of KB chunks passed to the LLM |
| `DEFAULT_AUDIENCE` | `agent` | Default audience tag filter |
| `DEFAULT_STATUS` | `active` | Default status tag filter |
| `SERVICE_PORT` | `3000` | Service port |
| `BIND_HOST` | `0.0.0.0` | Service bind host |
| `OPENAI_TIMEOUT_MS` | `20000` | OpenAI request timeout |
| `REQUEST_TIMEOUT_MS` | `25000` | HTTP request timeout |
| `DEBUG_ENRICH` | `0` | Enable debug logging when set to `1` |

## 1) Prereqs
- MySQL 8.0.44 (community builds do not include VECTOR support by default)
- Node.js 18+

## 2) Create schema
- Run:
  ```bash
  mysql -u bs_user -p bookstack < sql/vector_schema.sql
  ```
- This schema stores embeddings as JSON for app-layer vector search.
- If you want in-DB vector search, install a MySQL build with VECTOR support
  and change the embedding column + VECTOR_EXPR accordingly.

## 3) Install Node dependencies
- Run:
  ```bash
  npm install
  ```

## 4) Configure environment
- Copy .env.example to .env and fill in:
  - DB_HOST, DB_USER, DB_PASSWORD, DB_NAME
  - OPENAI_API_KEY
  - EMBEDDING_MODEL (match your vector dimension)
  - VECTOR_EXPR if your MySQL build supports VECTOR columns
  - CANDIDATE_LIMIT to cap rows scored in app
  - LLM_MODEL (default: gpt-5.2)
  - SERVICE_PORT (default: 3000)

## 5) Run embeddings (index BookStack pages)
- Default behavior only re-embeds changed pages.
- Full overwrite:
  ```bash
  node scripts/index_kb.js --overwrite
  ```
- Limit pages:
  ```bash
  node scripts/index_kb.js --limit 50
  ```
- Single page:
  ```bash
  node scripts/index_kb.js --page-id 123
  ```
- Since timestamp:
  ```bash
  node scripts/index_kb.js --since "2026-01-01 00:00:00"
  ```

### 5b) Tag KB pages for better filtering (optional but recommended)
- In BookStack UI, add page tags:
  - audience=agent
  - status=active
  - product=<ProductName>
- These are used by the search script filters (--audience/--status/--product).
- For bulk tagging, see: sql/tag_helpers.sql

## 6) Test vector search
- Example:
  ```bash
  npm run search:kb -- --text "User cannot login after password reset" --limit 5
  ```
- With product filter:
  ```bash
  npm run search:kb -- --text "VPN setup" --product "AcmeVPN"
  ```
- Increase candidates if results look thin:
  ```bash
  npm run search:kb -- --text "VPN setup" --candidate-limit 5000
  ```
- Hybrid keyword prefilter (default on):
  ```bash
  npm run search:kb -- --text "password reset error 401" --keyword-limit 200 --term-limit 25
  ```
- Disable keyword prefilter:
  ```bash
  npm run search:kb -- --text "password reset error 401" --disable-keywords
  ```

## 7) Validate counts
- Check chunk count:
  ```sql
  SELECT COUNT(*) FROM kb_chunk;
  ```
- Spot-check a page:
  ```sql
  SELECT * FROM kb_chunk WHERE page_id=123 LIMIT 3;
  ```

## 8) Iteration notes
- Re-run index after KB content updates.
- If you change EMBEDDING_MODEL dimensionality, reindex embeddings.

## 9) Run the enrichment service
- Start:
  ```bash
  npm run serve:enrich
  ```
- Enable debug logs:
  ```bash
  DEBUG_ENRICH=1 npm run serve:enrich
  ```
- UI: http://<server-ip>:3000/ui
- Example request:
  ```bash
  curl -s http://localhost:3000/api/enrich-ticket \\
    -H 'Content-Type: application/json' \\
    -d '{"ticket_id":"TCK-100293","ticket_text":"User cannot login after password reset","product":null}'
  ```

## 10) Test OpenAI connectivity
- Run:
  ```bash
  npm run ping:openai
  ```
