BEGIN;
DROP TABLE receipt_changes;
ALTER TABLE message_receipts DROP CONSTRAINT ck_read_requires_delivered;
ALTER TABLE conversations DROP COLUMN last_receipt_seq;
COMMIT;
