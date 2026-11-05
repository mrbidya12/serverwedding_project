-- ================================================================
-- 1. Enable UUID generation
-- ================================================================
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ================================================================
-- 2. USERS TABLE – with all columns used in auth-service
-- ================================================================
CREATE TABLE IF NOT EXISTS users (
    id VARCHAR(255) PRIMARY KEY DEFAULT uuid_generate_v4(),
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    role VARCHAR(20) NOT NULL DEFAULT 'client' CHECK (role IN ('client', 'admin', 'vendor')),
    name VARCHAR(100) NOT NULL,
    phone VARCHAR(20),
    country VARCHAR(100),
    state VARCHAR(100),
    city VARCHAR(100),
    block VARCHAR(100),
    pincode VARCHAR(20),
    profile_picture TEXT,
    upi_id VARCHAR(255),
    upi_name VARCHAR(255),
    blocked_until TIMESTAMP WITH TIME ZONE,
    blocked_reason TEXT,
    email_verified BOOLEAN DEFAULT FALSE,
    phone_verified BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Insert system user for broadcast messages
INSERT INTO users (id, email, password_hash, role, name)
VALUES ('system', 'system@wedding.com', 'dummy', 'admin', 'System')
ON CONFLICT (id) DO NOTHING;

-- ================================================================
-- 3. VENDORS TABLE – with all columns used in vendor-service
-- ================================================================
CREATE TABLE IF NOT EXISTS vendors (
    id VARCHAR(255) PRIMARY KEY DEFAULT uuid_generate_v4(),
    owner_id VARCHAR(255) REFERENCES users(id) ON DELETE CASCADE,
    name VARCHAR(100) NOT NULL,
    category VARCHAR(50) DEFAULT 'OTHER' CHECK (category IN (
        'PHOTOGRAPHER', 'DECORATION', 'CATERING', 'MEHENDI',
        'DJ', 'MAKEUP', 'VENUE', 'FLORIST', 'OTHER'
    )),
    description TEXT,
    phone VARCHAR(20),
    country VARCHAR(100),
    state VARCHAR(100),
    city VARCHAR(100),
    block VARCHAR(100),
    pincode VARCHAR(20),
    upi_id VARCHAR(255),
    upi_name VARCHAR(255),
    years_of_experience INTEGER,
    min_price DECIMAL(10,2),
    max_price DECIMAL(10,2),
    approved BOOLEAN DEFAULT FALSE,
    no_show_count INTEGER DEFAULT 0,
    blocked_permanently BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- ================================================================
-- 4. BOOKINGS TABLE – with full booking form fields
-- ================================================================
CREATE TABLE IF NOT EXISTS bookings (
    id VARCHAR(255) PRIMARY KEY DEFAULT uuid_generate_v4(),
    client_id VARCHAR(255) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    vendor_id VARCHAR(255) NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
    event_name VARCHAR(255) NOT NULL,
    event_type VARCHAR(50) NOT NULL,
    guest_count INTEGER NOT NULL,
    budget DECIMAL(10,2) NOT NULL,
    event_date DATE NOT NULL,
    event_time TIME NOT NULL,
    event_end_time TIME NOT NULL,
    venue_location TEXT NOT NULL,
    special_requests TEXT,
    client_upi_id VARCHAR(255) NOT NULL,
    client_upi_name VARCHAR(255) NOT NULL,
    total_price DECIMAL(10,2),
    status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'cancelled', 'completed', 'no_show')),
    notes TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    cancelled_at TIMESTAMP WITH TIME ZONE,
    cancelled_by VARCHAR(255),
    cancel_reason TEXT,
    refund_amount DECIMAL(10,2)
);

-- ================================================================
-- 5. PAYMENT REQUESTS – with commission & payout fields
-- ================================================================
CREATE TABLE IF NOT EXISTS payment_requests (
    id VARCHAR(255) PRIMARY KEY DEFAULT uuid_generate_v4(),
    from_vendor_id VARCHAR(255) NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
    to_client_id VARCHAR(255) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    booking_id VARCHAR(255) REFERENCES bookings(id) ON DELETE SET NULL,
    amount DECIMAL(10,2) NOT NULL,
    status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'expired', 'released', 'refunded')),
    qr_code TEXT,
    qr_expires_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() + INTERVAL '5 minutes',
    commission_rate DECIMAL(5,2),
    commission_amount DECIMAL(10,2),
    net_amount DECIMAL(10,2),
    payout_status VARCHAR(20) DEFAULT 'none' CHECK (payout_status IN ('none', 'pending', 'processed', 'failed')),
    admin_upi_id VARCHAR(255),
    transaction_ref VARCHAR(255),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    paid_at TIMESTAMP WITH TIME ZONE,
    released_at TIMESTAMP WITH TIME ZONE,
    refunded_at TIMESTAMP WITH TIME ZONE,
    payout_date TIMESTAMP WITH TIME ZONE
);

-- ================================================================
-- 6. PAYMENT TRANSACTIONS
-- ================================================================
CREATE TABLE IF NOT EXISTS payment_transactions (
    id VARCHAR(255) PRIMARY KEY DEFAULT uuid_generate_v4(),
    payment_request_id VARCHAR(255) REFERENCES payment_requests(id) ON DELETE CASCADE,
    transaction_id VARCHAR(255) UNIQUE NOT NULL,
    amount DECIMAL(10,2) NOT NULL,
    status VARCHAR(20) DEFAULT 'initiated' CHECK (status IN ('initiated', 'success', 'failed', 'refunded')),
    payment_method VARCHAR(50),
    payment_details JSONB,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- ================================================================
-- 7. REFUND REQUESTS – with net refund & platform fee
-- ================================================================
CREATE TABLE IF NOT EXISTS refund_requests (
    id VARCHAR(255) PRIMARY KEY DEFAULT uuid_generate_v4(),
    payment_request_id VARCHAR(255) NOT NULL REFERENCES payment_requests(id) ON DELETE CASCADE,
    client_id VARCHAR(255) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    amount DECIMAL(10,2) NOT NULL,          -- gross refund
    net_refund DECIMAL(10,2),               -- amount after platform fee
    platform_fee DECIMAL(10,2),
    reason TEXT,
    status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'processed')),
    refund_percentage INTEGER,               -- 0, 50, 100
    platform_cut DECIMAL(10,2),
    vendor_amount DECIMAL(10,2),
    admin_notes TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    processed_at TIMESTAMP WITH TIME ZONE
);

-- ================================================================
-- 8. VENDOR WORK STATUS – with OTP and times
-- ================================================================
CREATE TABLE IF NOT EXISTS vendor_work_status (
    id VARCHAR(255) PRIMARY KEY DEFAULT uuid_generate_v4(),
    vendor_id VARCHAR(255) NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
    booking_id VARCHAR(255) UNIQUE REFERENCES bookings(id) ON DELETE CASCADE,
    client_id VARCHAR(255) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'arrived', 'started', 'working', 'waiting_completion', 'completed', 'claimed')),
    arrived_at TIMESTAMP WITH TIME ZONE,
    start_time TIMESTAMP WITH TIME ZONE,
    working_at TIMESTAMP WITH TIME ZONE,
    end_time TIMESTAMP WITH TIME ZONE,
    completed_at TIMESTAMP WITH TIME ZONE,
    claimed_at TIMESTAMP WITH TIME ZONE,
    duration_hours INTEGER DEFAULT 2,
    location_lat DECIMAL(10,8),
    location_lng DECIMAL(11,8),
    otp VARCHAR(6),
    otp_expires_at TIMESTAMP WITH TIME ZONE,
    work_otp VARCHAR(6),
    work_otp_expires_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- ================================================================
-- 9. MESSAGES – with nullable from_user_id for system messages
-- ================================================================
CREATE TABLE IF NOT EXISTS messages (
    id VARCHAR(255) PRIMARY KEY DEFAULT uuid_generate_v4(),
    from_user_id VARCHAR(255) REFERENCES users(id) ON DELETE SET NULL,
    to_user_id VARCHAR(255) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    vendor_id VARCHAR(255) REFERENCES vendors(id) ON DELETE CASCADE,
    content TEXT NOT NULL,
    type VARCHAR(20) DEFAULT 'text' NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    is_deleted BOOLEAN DEFAULT FALSE
);

-- ================================================================
-- 10. OTP ATTEMPTS – for login/phone/email verification
-- ================================================================
CREATE TABLE IF NOT EXISTS otp_attempts (
    id VARCHAR(255) PRIMARY KEY DEFAULT uuid_generate_v4(),
    identifier VARCHAR(255) NOT NULL,          -- email or phone or booking_id
    otp VARCHAR(6) NOT NULL,
    action VARCHAR(50) NOT NULL,               -- 'verify', 'start_work', 'complete_work'
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    attempts INTEGER DEFAULT 0,
    locked_until TIMESTAMP WITH TIME ZONE,
    verified BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- ================================================================
-- 11. NOTIFICATIONS – for in-app alerts
-- ================================================================
CREATE TABLE IF NOT EXISTS notifications (
    id VARCHAR(255) PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id VARCHAR(255) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type VARCHAR(50) NOT NULL,
    content TEXT NOT NULL,
    related_id VARCHAR(255),
    read_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- ================================================================
-- 12. CANCELLATION REQUESTS – for admin approval
-- ================================================================
CREATE TABLE IF NOT EXISTS cancellation_requests (
    id VARCHAR(255) PRIMARY KEY DEFAULT uuid_generate_v4(),
    booking_id VARCHAR(255) NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
    cancelled_by VARCHAR(20) NOT NULL CHECK (cancelled_by IN ('client', 'vendor')),
    refund_percent INTEGER NOT NULL CHECK (refund_percent IN (0, 50, 100)),
    refund_amount DECIMAL(10,2) NOT NULL DEFAULT 0,
    status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
    cancelled_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    processed_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- ================================================================
-- 13. REPORTS – for user reporting
-- ================================================================
CREATE TABLE IF NOT EXISTS reports (
    id VARCHAR(255) PRIMARY KEY DEFAULT uuid_generate_v4(),
    reporter_id VARCHAR(255) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    reported_user_id VARCHAR(255) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    reason TEXT NOT NULL,
    status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'resolved', 'dismissed')),
    admin_notes TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    resolved_at TIMESTAMP WITH TIME ZONE
);

-- ================================================================
-- 14. USER LOCATIONS – for nearby vendors
-- ================================================================
CREATE TABLE IF NOT EXISTS user_locations (
    id VARCHAR(255) PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id VARCHAR(255) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    latitude DECIMAL(10,8) NOT NULL,
    longitude DECIMAL(11,8) NOT NULL,
    accuracy DECIMAL(10,2),
    is_active BOOLEAN DEFAULT TRUE,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- ================================================================
-- 15. REVIEWS – for vendor ratings
-- ================================================================
CREATE TABLE IF NOT EXISTS reviews (
    id VARCHAR(255) PRIMARY KEY DEFAULT uuid_generate_v4(),
    client_id VARCHAR(255) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    vendor_id VARCHAR(255) NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
    rating INTEGER CHECK (rating BETWEEN 1 AND 5),
    comment TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- ================================================================
-- 16. BLOCK CHATS – for admin chat blocking
-- ================================================================
CREATE TABLE IF NOT EXISTS block_chats (
    id VARCHAR(255) PRIMARY KEY DEFAULT uuid_generate_v4(),
    user1_id VARCHAR(255) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    user2_id VARCHAR(255) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    blocked_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE (user1_id, user2_id)
);

-- ================================================================
-- 17. BLOCKED USERS – for admin user blocking (legacy)
-- ================================================================
CREATE TABLE IF NOT EXISTS blocked_users (
    id VARCHAR(255) PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id VARCHAR(255) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    blocked_by VARCHAR(255) NOT NULL REFERENCES users(id),
    reason TEXT,
    blocked_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- ================================================================
-- 18. USER BLOCKS – alternative block tracking
-- ================================================================
CREATE TABLE IF NOT EXISTS user_blocks (
    id VARCHAR(255) PRIMARY KEY DEFAULT uuid_generate_v4(),
    blocked_user_id VARCHAR(255) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    blocked_by_admin_id VARCHAR(255) NOT NULL REFERENCES users(id),
    reason TEXT,
    blocked_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    expires_at TIMESTAMP WITH TIME ZONE
);

-- ================================================================
-- 19. INDEXES FOR PERFORMANCE
-- ================================================================
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);
CREATE INDEX IF NOT EXISTS idx_vendors_owner ON vendors(owner_id);
CREATE INDEX IF NOT EXISTS idx_vendors_category ON vendors(category);
CREATE INDEX IF NOT EXISTS idx_bookings_client ON bookings(client_id);
CREATE INDEX IF NOT EXISTS idx_bookings_vendor ON bookings(vendor_id);
CREATE INDEX IF NOT EXISTS idx_bookings_status ON bookings(status);
CREATE INDEX IF NOT EXISTS idx_messages_users ON messages(from_user_id, to_user_id);
CREATE INDEX IF NOT EXISTS idx_payment_requests_client ON payment_requests(to_client_id);
CREATE INDEX IF NOT EXISTS idx_payment_requests_vendor ON payment_requests(from_vendor_id);
CREATE INDEX IF NOT EXISTS idx_otp_attempts_identifier ON otp_attempts(identifier);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id);
CREATE INDEX IF NOT EXISTS idx_notifications_created ON notifications(created_at DESC);
CREATE TABLE IF NOT EXISTS user_blocks (
  blocker_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  PRIMARY KEY (blocker_id, blocked_id)
);
