-- ================================================================
--   MIGRATION: Feedback, Notifications, Reports, Vendor Priority
-- ================================================================

-- 1.1 Extend reviews table
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS rating INTEGER CHECK (rating >= 1 AND rating <= 5);
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS image_url TEXT;
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS vendor_id UUID REFERENCES vendors(id);
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS client_id UUID REFERENCES users(id);
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS booking_id UUID REFERENCES bookings(id);
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS feedback_text TEXT;

-- 1.2 Vendor profile stats
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS profile_views INTEGER DEFAULT 0;
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS photo_url TEXT;

-- 1.3 Notifications table
CREATE TABLE IF NOT EXISTS notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id),
  type TEXT,
  message TEXT,
  read BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW(),
  metadata JSONB
);

-- 1.4 Reports table
CREATE TABLE IF NOT EXISTS reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id UUID REFERENCES vendors(id),
  reporter_id UUID REFERENCES users(id),
  reason TEXT,
  description TEXT,
  status TEXT DEFAULT 'pending',
  created_at TIMESTAMP DEFAULT NOW()
);

-- 1.5 Booking status column
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'requested';

-- 1.6 Priority function
CREATE OR REPLACE FUNCTION get_vendor_priority(vendor_id UUID)
RETURNS TEXT AS $$
DECLARE
  total_reviews INT;
  good_reviews INT;
  good_percentage FLOAT;
BEGIN
  SELECT COUNT(*), COUNT(CASE WHEN rating >= 4 THEN 1 END)
  INTO total_reviews, good_reviews
  FROM reviews
  WHERE vendor_id = $1;

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

-- 1.7 Add priority column to vendors for performance (optional cache)
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS priority_level TEXT DEFAULT 'Moderate';

-- Update existing vendors with priority
UPDATE vendors SET priority_level = get_vendor_priority(id);

-- Trigger to update priority when reviews change
CREATE OR REPLACE FUNCTION update_vendor_priority_trigger()
RETURNS TRIGGER AS $$
BEGIN
  PERFORM get_vendor_priority(NEW.vendor_id);
  UPDATE vendors SET priority_level = get_vendor_priority(NEW.vendor_id) WHERE id = NEW.vendor_id;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_update_priority ON reviews;
CREATE TRIGGER trg_update_priority
AFTER INSERT OR UPDATE OR DELETE ON reviews
FOR EACH ROW EXECUTE FUNCTION update_vendor_priority_trigger();
