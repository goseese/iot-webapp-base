-- Auto claim membership mode (DECISIONS.md "Auto claim membership mode"; devmon migration 0023).
-- membership_mode gains the value 'auto_claim' (fits VARCHAR(10), no constraint to change). While it
-- is on, this is when it ends; past it the location claims nothing and the minute job sets the mode
-- back to 'normal'. NULL with 'auto_claim' means no timeout (honoured by the code, not offered on
-- the page). unclaimed_heard and unclaimed_ignored, the rest of devmon's 0023 and 0025, are in the
-- baseline already.
ALTER TABLE locations ADD COLUMN auto_claim_until_epoch BIGINT NULL;
