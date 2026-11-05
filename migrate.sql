CREATE TABLE users (
    id VARCHAR(36) PRIMARY KEY,
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    role VARCHAR(20) DEFAULT 'client',
    name VARCHAR(255) NOT NULL,
    phone VARCHAR(20),
    country VARCHAR(100),
    state VARCHAR(100),
    city VARCHAR(100),
    block VARCHAR(100),
    pincode VARCHAR(20),
    profile_picture TEXT,
    public_key TEXT,
    created_at TIMESTAMP DEFAULT NOW(),
    blocked_until TIMESTAMP,
    blocked_reason TEXT,
    email_verified BOOLEAN DEFAULT FALSE,
    phone_verified BOOLEAN DEFAULT FALSE
);

CREATE TABLE vendors (
    id VARCHAR(36) PRIMARY KEY,
    owner_id VARCHAR(36) REFERENCES users(id),
    name VARCHAR(255) NOT NULL,
    category VARCHAR(50),
    years_of_experience INT,
    min_price DECIMAL(10,2),
    max_price DECIMAL(10,2),
    phone VARCHAR(20),
    country VARCHAR(100),
    state VARCHAR(100),
    city VARCHAR(100),
    block VARCHAR(100),
    pincode VARCHAR(20),
    approved BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE reviews (
    id VARCHAR(36) PRIMARY KEY,
    client_id VARCHAR(36) REFERENCES users(id),
    vendor_id VARCHAR(36) REFERENCES vendors(id),
    rating INT CHECK (rating >= 1 AND rating <= 5),
    comment TEXT,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE otp_attempts (
    id SERIAL PRIMARY KEY,
    identifier VARCHAR(255) NOT NULL,
    otp VARCHAR(6) NOT NULL,
    expires_at TIMESTAMP NOT NULL,
    action VARCHAR(20) NOT NULL,
    verified BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT NOW()
);
