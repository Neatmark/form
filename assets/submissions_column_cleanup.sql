-- =====================================================================
-- submissions_column_cleanup.sql
-- ---------------------------------------------------------------------
-- Focused migration for your current schema style: "q1-*", "q2-*", ...
-- Removes question-order prefixes and keeps descriptive hyphenated names.
--
-- Safe behavior:
-- - If old column exists and target doesn't: rename old -> target.
-- - If both exist: copy missing values into target, then drop old.
-- - If old doesn't exist: no-op.
-- =====================================================================

BEGIN;

DO $$
DECLARE
  rec record;
BEGIN
  FOR rec IN
    SELECT *
    FROM (
      VALUES
        ('q1-business-description',   'business-description'),
        ('q2-problem-transformation', 'problem-transformation'),
        ('q3-ideal-customer',         'ideal-customer'),
        ('q3b-customer-desire',       'customer-desire'),
        ('q4-competitors',            'competitors'),
        ('q5-brand-personality',      'brand-personality'),
        ('q6-positioning',            'positioning'),
        ('q-launch-context',          'launch-context'),
        ('q8-brands-admired',         'brands-admired'),
        ('q9-color',                  'color_direction'),
        ('q10-colors-to-avoid',       'colors-to-avoid'),
        ('q11-aesthetic',             'aesthetic'),
        ('q11-aesthetic-description', 'aesthetic-description'),
        ('q13-deliverables',          'deliverables'),
        ('q14-budget',                'budget'),
        ('q15-inspiration-refs',      'inspiration-refs'),
        ('q7-decision-maker',         'decision-maker'),
        ('q7-decision-maker-other',   'decision-maker-other'),
        ('q12-existing-assets',       'existing-assets'),
        ('q16-anything-else',         'anything-else')
    ) AS t(old_col, new_col)
  LOOP
    IF EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'submissions'
        AND column_name = rec.old_col
    ) THEN

      IF EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'submissions'
          AND column_name = rec.new_col
      ) THEN
        EXECUTE format(
          'UPDATE public.submissions
              SET %I = COALESCE(%I, %I)
            WHERE %I IS NULL
              AND %I IS NOT NULL',
          rec.new_col, rec.new_col, rec.old_col, rec.new_col, rec.old_col
        );

        EXECUTE format('ALTER TABLE public.submissions DROP COLUMN %I', rec.old_col);
      ELSE
        EXECUTE format('ALTER TABLE public.submissions RENAME COLUMN %I TO %I', rec.old_col, rec.new_col);
      END IF;

    END IF;
  END LOOP;
END $$;

COMMIT;

-- Optional verification
-- SELECT column_name
-- FROM information_schema.columns
-- WHERE table_schema = 'public' AND table_name = 'submissions'
-- ORDER BY ordinal_position;
