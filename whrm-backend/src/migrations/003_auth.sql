-- Login ระดับระบบ: ผู้ใช้ (app_user เดิม) + session แบบ token ทึบ (เก็บเฉพาะ hash) — ยกเลิก/หมดอายุได้จาก server

ALTER TABLE app_user
  ADD COLUMN last_login_at timestamptz,
  ADD COLUMN created_at    timestamptz NOT NULL DEFAULT now();

CREATE TABLE auth_session (
  token_hash   text PRIMARY KEY,          -- sha256(token) — ตัว token อยู่ใน cookie ของ browser เท่านั้น
  username     text NOT NULL REFERENCES app_user (username) ON DELETE CASCADE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  ip           text,
  user_agent   text
);
CREATE INDEX auth_session_user_idx ON auth_session (username);
CREATE INDEX auth_session_expires_idx ON auth_session (expires_at);
