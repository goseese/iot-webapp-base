-- A sensor can opt out of a tag it would inherit from its device (DECISIONS.md, tags).
-- Kept apart from DTM_taggings so a reader that ignores exclusions falls back to plain inheritance,
-- never to treating an excluded tag as the sensor's own.
CREATE TABLE DTM_tag_exclusions
(
    id INT IDENTITY(1,1) PRIMARY KEY,
    tag_id INT NOT NULL,
    entity_type NVARCHAR(10) NOT NULL,               -- sensor
    entity_id INT NOT NULL,
    CONSTRAINT fk_DTM_tag_exclusions_tags FOREIGN KEY (tag_id) REFERENCES DTM_tags (id)
);
CREATE UNIQUE INDEX ux_DTM_tag_exclusions ON DTM_tag_exclusions (tag_id, entity_type, entity_id);
CREATE INDEX ix_DTM_tag_exclusions_entity ON DTM_tag_exclusions (entity_type, entity_id);
