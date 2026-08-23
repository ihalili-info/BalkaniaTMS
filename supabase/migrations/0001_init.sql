-- Enable PostGIS extension for distance & geofencing calculations
CREATE EXTENSION IF NOT EXISTS postgis;

-- 1. Trucks Table
CREATE TABLE trucks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  license_plate TEXT NOT NULL,
  gps_device_id TEXT UNIQUE NOT NULL,
  current_location GEOGRAPHY(POINT, 4326),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 2. Orders Table
CREATE TABLE orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  crm_order_id TEXT UNIQUE NOT NULL,
  customer_name TEXT NOT NULL,
  customer_phone TEXT NOT NULL,
  delivery_address TEXT NOT NULL,
  delivery_location GEOGRAPHY(POINT, 4326),
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'assigned', 'en_route', 'delivered')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 3. Loads Table (Grouping Orders to Trucks)
CREATE TABLE loads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  truck_id UUID REFERENCES trucks(id) ON DELETE SET NULL,
  status TEXT DEFAULT 'planned' CHECK (status IN ('planned', 'active', 'completed')),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 4. Load Items (Stop Sequence & Delivery Tracking)
CREATE TABLE load_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  load_id UUID REFERENCES loads(id) ON DELETE CASCADE,
  order_id UUID REFERENCES orders(id) ON DELETE CASCADE,
  stop_sequence INT NOT NULL,
  delivered_at TIMESTAMPTZ
);

-- 5. Notifications Table (per-type alert log — supports dispatch/proximity/
-- delivery alerts firing independently per stop, guarded against duplicates)
CREATE TABLE notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  load_item_id UUID REFERENCES load_items(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('dispatch_confirmation', 'proximity_alert', 'delivery_complete')),
  sent_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (load_item_id, type)
);

-- Spatial indexes for efficient proximity queries
CREATE INDEX idx_trucks_location ON trucks USING GIST (current_location);
CREATE INDEX idx_orders_location ON orders USING GIST (delivery_location);
