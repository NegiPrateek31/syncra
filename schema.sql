-- Syncra: Core Database Schema (PostgreSQL)
-- Implements "First-to-Cloud" concurrency and Role-Based Access Control

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Define Enums for static constraints safely
CREATE TYPE user_role AS ENUM ('owner', 'salesman');
CREATE TYPE product_status AS ENUM ('available', 'locked', 'sold');
CREATE TYPE bill_status AS ENUM ('pending', 'finalized', 'cancelled');
CREATE TYPE subscription_tier AS ENUM ('starter', 'professional', 'enterprise');

-- 1. Businesses Table (Multi-tenancy)
CREATE TABLE businesses (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(255) NOT NULL,
    type VARCHAR(50) NOT NULL, -- "Clothing", "Electronics"
    subscription subscription_tier NOT NULL DEFAULT 'starter',
    trial_ends_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 2. Users Table (Role Management)
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    business_id UUID REFERENCES businesses(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    email VARCHAR(255) UNIQUE,
    phone VARCHAR(20) UNIQUE,
    role user_role NOT NULL,
    password_hash TEXT, -- Owner password or Salesman PIN
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 3. Invites Table
CREATE TABLE invites (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    business_id UUID REFERENCES businesses(id) ON DELETE CASCADE,
    contact VARCHAR(255) NOT NULL, -- Email or Phone
    otp VARCHAR(6),
    otp_expires_at TIMESTAMP WITH TIME ZONE,
    is_accepted BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 4. Products Table (Catalog)
CREATE TABLE products (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    business_id UUID REFERENCES businesses(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    brand VARCHAR(100) NOT NULL,
    sku VARCHAR(100) NOT NULL,
    category VARCHAR(100) NOT NULL,
    description TEXT,
    price DECIMAL(10, 2) NOT NULL,
    color_index INTEGER DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 5. Product Images
CREATE TABLE product_images (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    product_id UUID REFERENCES products(id) ON DELETE CASCADE,
    image_url TEXT NOT NULL,
    is_thumbnail BOOLEAN DEFAULT FALSE,
    sort_order INTEGER DEFAULT 0
);

-- 6. Bills Table (Pending Queue Management)
CREATE TABLE bills (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    business_id UUID REFERENCES businesses(id) ON DELETE CASCADE,
    token_id VARCHAR(10) NOT NULL, -- Short readable ID (e.g. #5521)
    salesman_id UUID REFERENCES users(id),
    status bill_status NOT NULL DEFAULT 'pending',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 7. Product Variants Table (The "Source of Truth" for Locks)
CREATE TABLE product_variants (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    product_id UUID REFERENCES products(id) ON DELETE CASCADE,
    size VARCHAR(20) NOT NULL,
    stock INTEGER NOT NULL DEFAULT 0,
    
    -- Concurrency & State Management
    status product_status NOT NULL DEFAULT 'available',
    locked_by UUID REFERENCES users(id) ON DELETE SET NULL,
    locked_at TIMESTAMP WITH TIME ZONE,
    bill_id UUID REFERENCES bills(id) ON DELETE SET NULL,
    version INTEGER NOT NULL DEFAULT 1, -- Optimistic Concurrency Control
    
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Indices to optimize concurrency lookups
CREATE INDEX idx_variants_status ON product_variants(status);
CREATE INDEX idx_bills_token ON bills(token_id);
CREATE INDEX idx_variants_lock_expiry ON product_variants(locked_at) WHERE status = 'locked';
CREATE INDEX idx_users_business ON users(business_id);
CREATE INDEX idx_products_business ON products(business_id);

-- Timestamp Triggers
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_bills_modtime BEFORE UPDATE ON bills FOR EACH ROW EXECUTE PROCEDURE update_updated_at_column();
CREATE TRIGGER update_variants_modtime BEFORE UPDATE ON product_variants FOR EACH ROW EXECUTE PROCEDURE update_updated_at_column();

