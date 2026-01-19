# Local Design: BookStack-Backed Ticket Enrichment

## Goal
Add vector search for KB content stored in this BookStack database with minimal schema changes. Use existing BookStack tables for content and metadata; add only the tables needed for embeddings and enrichment logging.

## BookStack Source Mapping
- KB articles are BookStack pages: `entities` rows where `type='page'`.
- Page text comes from `entity_page_data.text` (join on `entities.id = entity_page_data.page_id`).
- Exclude drafts/templates and deleted pages: `entity_page_data.draft=0`, `entity_page_data.template=0`, `entities.deleted_at IS NULL`.
- Metadata filters map to tags on pages (`tags.entity_type='page'`):
  - `product` => tag name `product`
  - `audience` => tag name `audience` (e.g., `agent`)
  - `status` => tag name `status` (e.g., `active`)

## Minimal Schema Additions
### kb_chunk
Stores embeddings for page chunks only.
```sql
CREATE TABLE kb_chunk (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  page_id BIGINT UNSIGNED NOT NULL,
  chunk_index INT NOT NULL,
  chunk_type ENUM('symptom','cause','resolution','notes') NULL,
  content TEXT NOT NULL,
  embedding VECTOR(1536),
  embedding_model VARCHAR(100) NOT NULL,
  source_updated_at TIMESTAMP NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY kb_chunk_page_id_index (page_id),
  CONSTRAINT fk_kb_chunk_page FOREIGN KEY (page_id) REFERENCES entities(id)
);

CREATE VECTOR INDEX idx_kb_chunk_embedding
ON kb_chunk (embedding)
USING HNSW;
```

### ticket_enrichment_log
```sql
CREATE TABLE ticket_enrichment_log (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  ticket_id VARCHAR(255) NOT NULL,
  retrieval_strategy VARCHAR(100) NOT NULL,
  kb_chunk_ids JSON NOT NULL,
  llm_model VARCHAR(100) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

## Retrieval Queries (Adapted)
### Vector search with BookStack filters
```sql
SELECT kc.id, kc.content, distance(kc.embedding, :ticket_embedding) AS score
FROM kb_chunk kc
JOIN entities e ON e.id = kc.page_id AND e.type = 'page' AND e.deleted_at IS NULL
JOIN entity_page_data epd ON epd.page_id = e.id AND epd.draft = 0 AND epd.template = 0
LEFT JOIN tags t_aud ON t_aud.entity_id = e.id AND t_aud.entity_type='page' AND t_aud.name='audience'
LEFT JOIN tags t_status ON t_status.entity_id = e.id AND t_status.entity_type='page' AND t_status.name='status'
LEFT JOIN tags t_prod ON t_prod.entity_id = e.id AND t_prod.entity_type='page' AND t_prod.name='product'
WHERE (t_aud.value = 'agent' OR t_aud.value IS NULL)
  AND (t_status.value = 'active' OR t_status.value IS NULL)
  AND (:product IS NULL OR t_prod.value = :product)
ORDER BY score ASC
LIMIT 20;
```

### Keyword search using BookStack search_terms
```sql
SELECT st.entity_id AS page_id, SUM(st.score) AS score
FROM search_terms st
WHERE st.entity_type='page' AND st.term IN (:terms)
GROUP BY st.entity_id
ORDER BY score DESC
LIMIT 20;
```

## Ingestion Notes
- Chunk from `entity_page_data.text` (300-600 tokens, 10-15% overlap).
- Store `source_updated_at` from `entities.updated_at` to detect re-embed needs.
- Use tags for filtering instead of adding new columns to BookStack tables.

## Open Questions
- Confirm tag conventions for `product`, `audience`, and `status`.
- Decide on embedding model and vector size (currently 1536).
