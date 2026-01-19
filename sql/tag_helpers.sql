-- Tag helper queries for BookStack pages

-- 1) Tag all pages in a specific book
-- Set @book_id and @product_value to desired values.
SET @book_id = 1;
SET @tag_name = 'product';
SET @tag_value = 'MyProduct';

INSERT INTO tags (entity_id, entity_type, name, value, `order`, created_at, updated_at)
SELECT e.id, 'page', @tag_name, @tag_value, 0, NOW(), NOW()
FROM entities e
WHERE e.type = 'page' AND e.book_id = @book_id
  AND NOT EXISTS (
    SELECT 1 FROM tags t
    WHERE t.entity_id = e.id AND t.entity_type = 'page'
      AND t.name = @tag_name AND t.value = @tag_value
  );

-- 2) Tag all pages under a chapter
SET @chapter_id = 1;
SET @tag_name = 'product';
SET @tag_value = 'MyProduct';

INSERT INTO tags (entity_id, entity_type, name, value, `order`, created_at, updated_at)
SELECT e.id, 'page', @tag_name, @tag_value, 0, NOW(), NOW()
FROM entities e
WHERE e.type = 'page' AND e.chapter_id = @chapter_id
  AND NOT EXISTS (
    SELECT 1 FROM tags t
    WHERE t.entity_id = e.id AND t.entity_type = 'page'
      AND t.name = @tag_name AND t.value = @tag_value
  );

-- 3) Tag pages by title match (case-insensitive)
SET @title_like = '%password%';
SET @tag_name = 'status';
SET @tag_value = 'active';

INSERT INTO tags (entity_id, entity_type, name, value, `order`, created_at, updated_at)
SELECT e.id, 'page', @tag_name, @tag_value, 0, NOW(), NOW()
FROM entities e
WHERE e.type = 'page' AND e.name LIKE @title_like
  AND NOT EXISTS (
    SELECT 1 FROM tags t
    WHERE t.entity_id = e.id AND t.entity_type = 'page'
      AND t.name = @tag_name AND t.value = @tag_value
  );

-- 4) Remove a tag value from pages in a book
SET @book_id = 1;
SET @tag_name = 'product';
SET @tag_value = 'MyProduct';

DELETE t
FROM tags t
JOIN entities e ON e.id = t.entity_id
WHERE e.type = 'page' AND e.book_id = @book_id
  AND t.entity_type = 'page'
  AND t.name = @tag_name
  AND t.value = @tag_value;
