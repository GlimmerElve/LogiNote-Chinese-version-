-- A short lease is private delivery policy, never an online-presence profile.
-- Each device owns its row, so one terminal cannot clear another terminal.
CREATE TABLE community_device_focus (
  device_id uuid PRIMARY KEY REFERENCES community_devices(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
CREATE INDEX community_device_focus_expiry_idx ON community_device_focus(expires_at);
