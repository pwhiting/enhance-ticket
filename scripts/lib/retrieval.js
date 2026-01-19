"use strict";

function extractTerms(text) {
  const stopwords = new Set([
    "a", "an", "and", "are", "as", "at", "be", "but", "by", "for", "from",
    "has", "have", "he", "her", "his", "i", "in", "into", "is", "it", "its",
    "me", "my", "not", "of", "on", "or", "our", "she", "that", "the", "their",
    "them", "there", "they", "this", "to", "was", "we", "were", "what", "when",
    "where", "which", "who", "will", "with", "you", "your",
  ]);
  const tokens = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean)
    .filter((token) => token.length >= 3 && !stopwords.has(token));

  const freq = new Map();
  for (const token of tokens) {
    freq.set(token, (freq.get(token) || 0) + 1);
  }

  return Array.from(freq.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([term]) => term);
}

function cosineSimilarity(a, b) {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    const vA = a[i];
    const vB = b[i] || 0;
    dot += vA * vB;
    normA += vA * vA;
    normB += vB * vB;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

async function fetchKeywordPageIds(connection, terms, keywordLimit) {
  if (!terms.length) return [];
  const placeholders = terms.map(() => "?").join(",");
  const keywordSql = `
    SELECT st.entity_id AS page_id, SUM(st.score) AS score
    FROM search_terms st
    WHERE st.entity_type = 'page' AND st.term IN (${placeholders})
    GROUP BY st.entity_id
    ORDER BY score DESC
    LIMIT ${keywordLimit}
  `;
  const [keywordRows] = await connection.execute(keywordSql, terms);
  return keywordRows.map((row) => row.page_id);
}

async function fetchCandidateChunks(connection, filters) {
  const { audience, status, product, candidateLimit, keywordPageIds } = filters;
  let pageFilterSql = "";
  const params = [audience, audience, status, status, product, product];

  if (keywordPageIds.length > 0) {
    const placeholders = keywordPageIds.map(() => "?").join(",");
    pageFilterSql = ` AND kc.page_id IN (${placeholders})`;
    params.push(...keywordPageIds);
  }

  const limitValue = Math.max(1, Math.floor(candidateLimit));
  const sql = `
    SELECT
      kc.id,
      kc.page_id,
      e.name AS page_title,
      kc.content,
      kc.embedding
    FROM kb_chunk kc
    JOIN entities e ON e.id = kc.page_id AND e.type = 'page' AND e.deleted_at IS NULL
    JOIN entity_page_data epd ON epd.page_id = e.id AND epd.draft = 0 AND epd.template = 0
    LEFT JOIN tags t_aud ON t_aud.entity_id = e.id AND t_aud.entity_type = 'page' AND t_aud.name = 'audience'
    LEFT JOIN tags t_status ON t_status.entity_id = e.id AND t_status.entity_type = 'page' AND t_status.name = 'status'
    LEFT JOIN tags t_prod ON t_prod.entity_id = e.id AND t_prod.entity_type = 'page' AND t_prod.name = 'product'
    WHERE (? IS NULL OR t_aud.value = ? OR t_aud.value IS NULL)
      AND (? IS NULL OR t_status.value = ? OR t_status.value IS NULL)
      AND (? IS NULL OR t_prod.value = ?)
      ${pageFilterSql}
    LIMIT ${limitValue}
  `;

  const [rows] = await connection.execute(sql, params);
  return rows;
}

async function searchKb({
  connection,
  queryEmbedding,
  text,
  audience,
  status,
  product,
  candidateLimit,
  keywordLimit,
  termLimit,
  disableKeywords,
  topK,
}) {
  let keywordPageIds = [];
  if (!disableKeywords) {
    const terms = extractTerms(text).slice(0, termLimit);
    const limit = Math.max(1, Math.floor(keywordLimit));
    keywordPageIds = await fetchKeywordPageIds(connection, terms, limit);
  }

  const candidates = await fetchCandidateChunks(connection, {
    audience,
    status,
    product,
    candidateLimit,
    keywordPageIds,
  });

  const scored = [];
  for (const row of candidates) {
    const stored = typeof row.embedding === "string" ? JSON.parse(row.embedding) : row.embedding;
    if (!Array.isArray(stored) || stored.length === 0) continue;
    const score = cosineSimilarity(stored, queryEmbedding);
    scored.push({ score, row });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK).map((item) => ({
    score: item.score,
    id: item.row.id,
    page_id: item.row.page_id,
    page_title: item.row.page_title,
    content: item.row.content,
  }));
}

module.exports = {
  extractTerms,
  searchKb,
};
