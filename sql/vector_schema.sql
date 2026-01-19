-- Vector search schema additions for BookStack-backed KB

CREATE TABLE IF NOT EXISTS kb_chunk (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  page_id BIGINT UNSIGNED NOT NULL,
  chunk_index INT NOT NULL,
  chunk_type ENUM('symptom','cause','resolution','notes') NULL,
  content TEXT NOT NULL,
  embedding JSON NOT NULL,
  embedding_model VARCHAR(100) NOT NULL,
  source_updated_at TIMESTAMP NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY kb_chunk_page_id_index (page_id),
  CONSTRAINT fk_kb_chunk_page FOREIGN KEY (page_id) REFERENCES entities(id)
);

-- MySQL community builds may not support VECTOR types.
-- Store embeddings as JSON and perform vector search in the app layer.

CREATE TABLE IF NOT EXISTS ticket_enrichment_log (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  ticket_id VARCHAR(255) NOT NULL,
  retrieval_strategy VARCHAR(100) NOT NULL,
  kb_chunk_ids JSON NOT NULL,
  llm_model VARCHAR(100) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
