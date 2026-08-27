-- Migration 018: Add quarterly frequency support and generated_reports table

-- 1. Update frequency check constraint on payroll_report_schedules
ALTER TABLE payroll_report_schedules
  DROP CONSTRAINT IF EXISTS payroll_report_schedules_frequency_check;

ALTER TABLE payroll_report_schedules
  ADD CONSTRAINT payroll_report_schedules_frequency_check
  CHECK (frequency IN ('weekly', 'monthly', 'quarterly'));

-- 2. Create generated_reports table for historical report tracking
CREATE TABLE IF NOT EXISTS generated_reports (
    id BIGSERIAL PRIMARY KEY,
    schedule_id BIGINT REFERENCES payroll_report_schedules(id) ON DELETE SET NULL,
    employer_id TEXT NOT NULL,
    period_start TIMESTAMPTZ NOT NULL,
    period_end TIMESTAMPTZ NOT NULL,
    frequency TEXT NOT NULL,
    format TEXT NOT NULL DEFAULT 'pdf',
    include_sections TEXT[] NOT NULL DEFAULT '{"summary","streams","withdrawals","vault_balance"}',
    ipfs_hash TEXT,
    ipfs_url TEXT,
    recipient_emails TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'success',
    error_message TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_generated_reports_employer ON generated_reports(employer_id);
CREATE INDEX IF NOT EXISTS idx_generated_reports_schedule ON generated_reports(schedule_id);
CREATE INDEX IF NOT EXISTS idx_generated_reports_created ON generated_reports(created_at DESC);

COMMENT ON TABLE generated_reports IS 'History of generated payroll reports with IPFS hashes and delivery status';
