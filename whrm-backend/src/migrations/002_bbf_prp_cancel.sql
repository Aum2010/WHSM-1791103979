-- UI v1790951454: BBF/EXP, PRP, ยกเลิก RU
-- ดู docs/04-ui-v2-change-review.md §6–7

-- BBF/EXP: เก็บทั้งข้อความที่พนักงานพิมพ์ และวันที่ที่แปลงแล้ว (พ.ศ. → ค.ศ.)
ALTER TABLE weighing_item
  ADD COLUMN bbf_exp_text text,
  ADD COLUMN bbf_exp      date,
  ADD COLUMN prp_status   text;          -- PRP: PENDING → CONFIRMED (ฝ่ายผลิตสแกนรับ)

CREATE INDEX weighing_item_bbf_exp_idx ON weighing_item (product_code, bbf_exp) WHERE bbf_exp IS NOT NULL;

-- ยกเลิก RU: WH13 ยกเลิก → server ส่ง RMA_CANCEL_RU → V4 ตอบ RMA_CANCEL_RU_DONE
-- ถ้ายังไม่มี DONE ส่งซ้ำให้ V4 ที่เพิ่งต่อเข้ามา (ภายใน 24 ชม.)
CREATE TABLE ru_cancel (
  ru_no          text PRIMARY KEY,
  cancelled_by   text,
  cancelled_at   timestamptz NOT NULL,
  source_device  text,
  sent_at        timestamptz,
  send_count     integer NOT NULL DEFAULT 0,
  done_at        timestamptz,
  done_device    text,
  rma_no         text
);
CREATE INDEX ru_cancel_pending_idx ON ru_cancel (cancelled_at) WHERE done_at IS NULL;
