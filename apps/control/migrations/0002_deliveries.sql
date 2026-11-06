-- Webhook deliveries already accepted, keyed by X-GitHub-Delivery.
CREATE TABLE deliveries (
  delivery_id TEXT PRIMARY KEY,
  received_at INTEGER NOT NULL
);
