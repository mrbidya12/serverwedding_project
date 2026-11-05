-- Fix 1: Change booking_id to TEXT to match bookings.id
ALTER TABLE reviews ALTER COLUMN booking_id TYPE TEXT;
ALTER TABLE reviews DROP CONSTRAINT IF EXISTS reviews_booking_id_fkey;
ALTER TABLE reviews ADD FOREIGN KEY (booking_id) REFERENCES bookings(id);

-- Fix 2: Update vendor priority (cast id to UUID)
UPDATE vendors SET priority_level = get_vendor_priority(id::UUID);

-- Fix 3: Ensure the function works with TEXT as well (optional but safe)
CREATE OR REPLACE FUNCTION get_vendor_priority(vendor_id TEXT)
RETURNS TEXT AS $$
DECLARE
  total_reviews INT;
  good_reviews INT;
  good_percentage FLOAT;
BEGIN
  SELECT COUNT(*), COUNT(CASE WHEN rating >= 4 THEN 1 END)
  INTO total_reviews, good_reviews
  FROM reviews
  WHERE vendor_id = vendor_id::UUID;

  IF total_reviews = 0 THEN
    RETURN 'Moderate';
  END IF;

  good_percentage := (good_reviews::FLOAT / total_reviews) * 100;

  IF good_percentage >= 70 THEN
    RETURN 'High';
  ELSIF good_percentage >= 30 THEN
    RETURN 'Moderate';
  ELSE
    RETURN 'Low';
  END IF;
END;
$$ LANGUAGE plpgsql;

-- Re-run priority update after function change
UPDATE vendors SET priority_level = get_vendor_priority(id);
