-- Migration 009: Add industry_category to propositions
--
-- Required before the website intake form can write this field.
-- Used in V2 for industry-aware gov data routing (replaces the flat
-- executeTool switch with routing based on the proposition's category).
--
-- Valid values mirror the industry_category constants in intake.js and
-- the website intake form's dropdown options.

ALTER TABLE propositions
  ADD COLUMN industry_category TEXT
  CHECK (industry_category IN (
    'food_beverage',
    'energy_clean_tech',
    'medical_devices',
    'chemicals_materials',
    'electronics',
    'apparel_textiles',
    'cosmetics',
    'general_manufacturing'
  ));

-- Backfill the existing camel milk proposition to the correct category.
-- All other existing rows stay NULL until they are updated via intake or admin panel.
UPDATE propositions
SET industry_category = 'food_beverage'
WHERE id = '54f51272-d819-4d82-825a-15603ed48654';
