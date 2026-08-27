-- Rollback Migration 018

DROP TABLE IF EXISTS generated_reports;

ALTER TABLE payroll_report_schedules
  DROP CONSTRAINT IF EXISTS payroll_report_schedules_frequency_check;

ALTER TABLE payroll_report_schedules
  ADD CONSTRAINT payroll_report_schedules_frequency_check
  CHECK (frequency IN ('weekly', 'monthly'));
