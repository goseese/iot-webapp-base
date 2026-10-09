-- Firmware update progress (DECISIONS.md "Firmware updates", command-protocol.md section 3; written for the pods). The
-- controller's {"event":"ota_progress","mac":..,"pct":N} events land on the ota command in flight,
-- one entry per pod: { "MAC": pct }. The ack still carries the final per-MAC results.
ALTER TABLE command_queue ADD COLUMN progress JSONB NULL;
