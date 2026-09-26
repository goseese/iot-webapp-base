-- Auto claim membership mode (DECISIONS "Auto claim membership mode"). membership_mode gains the
-- value 'auto_claim' (fits NVARCHAR(10), no constraint to change). While it is on, this is when it
-- ends; past it the location claims nothing and a leader job sets the mode back to 'normal'.
-- NULL with 'auto_claim' means no timeout (honoured by the code, not offered on the page).
ALTER TABLE DTM_locations ADD auto_claim_until_epoch BIGINT NULL;

-- Which gateways hear a MAC that is on no live device, one row per MAC and gateway placement,
-- shaped like DTM_device_coverage (DECISIONS "Unclaimed devices, per account"). Written by ingest
-- only while the MAC is unplaced; rows not heard for a while are purged by the daily job.
CREATE TABLE DTM_unclaimed_heard
(
    id INT IDENTITY(1,1) PRIMARY KEY,
    mac CHAR(12) NOT NULL,
    gateway_id INT NOT NULL,
    last_heard_epoch BIGINT NOT NULL,
    last_rssi SMALLINT NULL,
    CONSTRAINT fk_DTM_unclaimed_heard_gateways FOREIGN KEY (gateway_id) REFERENCES DTM_devices (id)
);
CREATE UNIQUE INDEX ux_DTM_unclaimed_heard_pair ON DTM_unclaimed_heard (mac, gateway_id);
CREATE INDEX ix_DTM_unclaimed_heard_gateway ON DTM_unclaimed_heard (gateway_id, last_heard_epoch);
