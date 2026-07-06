-- Service-log photos discovered from ION /mobileImage/uploadList.cfm (RefID = ion_log_id).
-- Thumbnails are public S3 URLs (stable, hot-linkable); full-size fetched on demand
-- via ProEdge getSignedUrl using s3_key. One row per (log, image GUID).
CREATE TABLE maintenance.visit_photos (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ion_log_id   text NOT NULL,
  guid         text NOT NULL,
  ion_cust_id  text,
  s3_key       text NOT NULL,   -- e.g. 3589/_Attachments/<cust>/<GUID>.jpg (for getSignedUrl)
  thumb_url    text NOT NULL,   -- public S3 t_<GUID>.jpg
  uploaded_by  text,
  uploaded_on  date,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (ion_log_id, guid)
);
CREATE INDEX idx_visit_photos_log ON maintenance.visit_photos (ion_log_id);
GRANT SELECT ON maintenance.visit_photos TO authenticated, anon, service_role;
GRANT INSERT, UPDATE, DELETE ON maintenance.visit_photos TO service_role;
