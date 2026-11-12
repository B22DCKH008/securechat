BEGIN;
ALTER TABLE conversations ADD COLUMN last_receipt_seq BIGINT NOT NULL DEFAULT 0;
ALTER TABLE message_receipts ADD CONSTRAINT ck_read_requires_delivered CHECK (read_at IS NULL OR delivered_at IS NOT NULL);
CREATE TABLE receipt_changes (
    conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    receipt_seq BIGINT NOT NULL CHECK (receipt_seq > 0),
    message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    message_seq BIGINT NOT NULL,
    recipient_id UUID NOT NULL REFERENCES users(id),
    sender_id UUID NOT NULL REFERENCES users(id),
    state TEXT NOT NULL CHECK (state IN ('delivered','read')),
    occurred_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (conversation_id,receipt_seq)
);
-- Existing state becomes a deterministic snapshot without publishing old events.
INSERT INTO receipt_changes
SELECT m.conversation_id,
       row_number() OVER (PARTITION BY m.conversation_id ORDER BY m.seq,r.user_id),
       m.id,m.seq,r.user_id,m.sender_id,
       CASE WHEN r.read_at IS NOT NULL THEN 'read' ELSE 'delivered' END,
       COALESCE(r.read_at,r.delivered_at)
FROM message_receipts r JOIN messages m ON m.id=r.message_id
WHERE COALESCE(r.read_at,r.delivered_at) IS NOT NULL;
UPDATE conversations c SET last_receipt_seq=r.max_seq
FROM (SELECT conversation_id,max(receipt_seq) max_seq FROM receipt_changes GROUP BY conversation_id) r
WHERE c.id=r.conversation_id;
COMMIT;
