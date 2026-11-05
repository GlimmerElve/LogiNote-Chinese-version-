-- Preserve all existing files and reservations while raising the enforced ceiling.
ALTER TABLE storage_reservations DROP CONSTRAINT storage_reservations_bytes_check;
ALTER TABLE storage_reservations ADD CONSTRAINT storage_reservations_bytes_check
  CHECK (bytes BETWEEN 1 AND 104857600);
ALTER TABLE private_attachments DROP CONSTRAINT private_attachments_bytes_check;
ALTER TABLE private_attachments ADD CONSTRAINT private_attachments_bytes_check
  CHECK (bytes BETWEEN 1 AND 104857600);
