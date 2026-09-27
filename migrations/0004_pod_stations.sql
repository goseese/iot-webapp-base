-- Pod stations (DECISIONS.md "Pod stations"): a target pod talks ESP-NOW to one controller pod,
-- which relays its frames. controller_id is the controller placement the target pod is paired with;
-- set by ingest when the pod's first frame arrives through a controller in pairing mode, and moved
-- when the pod is paired with another controller. NULL for everything that is not a target pod.
ALTER TABLE devices ADD COLUMN controller_id INTEGER NULL;
ALTER TABLE devices ADD CONSTRAINT fk_devices_controller FOREIGN KEY (controller_id) REFERENCES devices (id);
CREATE INDEX ix_devices_controller ON devices (controller_id) WHERE controller_id IS NOT NULL;
