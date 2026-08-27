import { getDb } from "./pool";
import { payrollReportSchedules, generatedReports } from "./schema";
import { eq, desc, and, lte, isNull, or } from "drizzle-orm";
import { DatabaseError } from "../errors/AppError";

export interface PayrollReportScheduleInput {
  employerId: string;
  frequency: "weekly" | "monthly" | "quarterly";
  dayOfMonth?: number | null;
  dayOfWeek?: number | null;
  email: string;
  includeSections?: string[];
  format?: "pdf" | "csv" | "both";
  enabled?: boolean;
  nextSendAt?: Date | null;
}

export interface PayrollReportSchedule extends Omit<
  PayrollReportScheduleInput,
  "format"
> {
  id: number;
  includeSections: string[];
  format: string;
  lastSentAt?: Date | null;
  nextSendAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface GeneratedReportInput {
  scheduleId?: number | null;
  employerId: string;
  periodStart: Date;
  periodEnd: Date;
  frequency: string;
  format: string;
  includeSections?: string[];
  ipfsHash?: string | null;
  ipfsUrl?: string | null;
  recipientEmails: string;
  status: "success" | "failed";
  errorMessage?: string | null;
}

export interface GeneratedReport extends GeneratedReportInput {
  id: number;
  createdAt: Date;
}

/**
 * Calculate next send date based on frequency and optional day preferences.
 * - weekly: next occurrence of dayOfWeek (0=Sun..6=Sat or 1=Mon..7=Sun), defaults to next Monday (1)
 * - monthly: next occurrence of dayOfMonth (1-28), defaults to 1st of next month
 * - quarterly: next occurrence of dayOfMonth (1-28) in 3 months
 */
export const calculateNextSendDate = (
  frequency: "weekly" | "monthly" | "quarterly" | string,
  dayOfMonth?: number | null,
  dayOfWeek?: number | null,
  fromDate: Date = new Date(),
): Date => {
  const next = new Date(fromDate);

  if (frequency === "weekly") {
    const targetDay =
      dayOfWeek !== undefined && dayOfWeek !== null ? dayOfWeek : 1; // default: Monday (1)
    const currentDay = next.getDay();
    const diff = (targetDay - currentDay + 7) % 7 || 7;
    next.setDate(next.getDate() + diff);
    next.setHours(9, 0, 0, 0);
    return next;
  } else if (frequency === "quarterly") {
    const targetDay =
      dayOfMonth !== undefined && dayOfMonth !== null
        ? Math.min(Math.max(dayOfMonth, 1), 28)
        : 1;
    const nextQuarter = new Date(
      next.getFullYear(),
      next.getMonth() + 3,
      targetDay,
      9,
      0,
      0,
      0,
    );
    return nextQuarter;
  } else {
    // monthly default
    const targetDay =
      dayOfMonth !== undefined && dayOfMonth !== null
        ? Math.min(Math.max(dayOfMonth, 1), 28)
        : 1;
    const nextMonth = new Date(
      next.getFullYear(),
      next.getMonth() + 1,
      targetDay,
      9,
      0,
      0,
      0,
    );
    return nextMonth;
  }
};

export const createReportSchedule = async (
  input: PayrollReportScheduleInput,
): Promise<PayrollReportSchedule> => {
  const db = getDb();
  if (!db) throw new DatabaseError("Database not initialized");

  const nextSendAt =
    input.nextSendAt ??
    calculateNextSendDate(input.frequency, input.dayOfMonth, input.dayOfWeek);

  const [schedule] = await db
    .insert(payrollReportSchedules)
    .values({
      ...input,
      nextSendAt,
      enabled: input.enabled ?? true,
    })
    .returning();

  return schedule as PayrollReportSchedule;
};

export const getReportSchedulesByEmployer = async (
  employerId: string,
): Promise<PayrollReportSchedule[]> => {
  const db = getDb();
  if (!db) return [];

  return db
    .select()
    .from(payrollReportSchedules)
    .where(eq(payrollReportSchedules.employerId, employerId))
    .orderBy(desc(payrollReportSchedules.createdAt)) as Promise<
    PayrollReportSchedule[]
  >;
};

export const getReportScheduleById = async (
  id: number,
): Promise<PayrollReportSchedule | null> => {
  const db = getDb();
  if (!db) return null;

  const [schedule] = await db
    .select()
    .from(payrollReportSchedules)
    .where(eq(payrollReportSchedules.id, id))
    .limit(1);

  return (schedule as PayrollReportSchedule) || null;
};

export const deleteReportSchedule = async (
  id: number,
  employerId: string,
): Promise<PayrollReportSchedule | null> => {
  const db = getDb();
  if (!db) return null;

  const [deleted] = await db
    .delete(payrollReportSchedules)
    .where(
      and(
        eq(payrollReportSchedules.id, id),
        eq(payrollReportSchedules.employerId, employerId),
      ),
    )
    .returning();

  return (deleted as PayrollReportSchedule) || null;
};

export const updateReportScheduleLastSent = async (
  id: number,
  nextSendAt: Date,
): Promise<void> => {
  const db = getDb();
  if (!db) return;

  await db
    .update(payrollReportSchedules)
    .set({
      lastSentAt: new Date(),
      nextSendAt,
      updatedAt: new Date(),
    })
    .where(eq(payrollReportSchedules.id, id));
};

export const updateReportSchedule = async (
  id: number,
  employerId: string,
  updates: Partial<PayrollReportScheduleInput>,
): Promise<PayrollReportSchedule | null> => {
  const db = getDb();
  if (!db) return null;

  const [updated] = await db
    .update(payrollReportSchedules)
    .set({
      ...updates,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(payrollReportSchedules.id, id),
        eq(payrollReportSchedules.employerId, employerId),
      ),
    )
    .returning();

  return (updated as PayrollReportSchedule) || null;
};

export const getEnabledSchedulesDue = async (): Promise<
  PayrollReportSchedule[]
> => {
  const db = getDb();
  if (!db) return [];

  const now = new Date();

  return db
    .select()
    .from(payrollReportSchedules)
    .where(
      and(
        eq(payrollReportSchedules.enabled, true),
        or(
          isNull(payrollReportSchedules.nextSendAt),
          lte(payrollReportSchedules.nextSendAt, now),
        ),
      ),
    )
    .orderBy(payrollReportSchedules.nextSendAt) as Promise<
    PayrollReportSchedule[]
  >;
};

export const recordGeneratedReport = async (
  input: GeneratedReportInput,
): Promise<GeneratedReport | null> => {
  const db = getDb();
  if (!db) return null;

  try {
    const [record] = await db
      .insert(generatedReports)
      .values({
        scheduleId: input.scheduleId ?? null,
        employerId: input.employerId,
        periodStart: input.periodStart,
        periodEnd: input.periodEnd,
        frequency: input.frequency,
        format: input.format,
        includeSections: input.includeSections ?? [
          "summary",
          "streams",
          "withdrawals",
          "vault_balance",
        ],
        ipfsHash: input.ipfsHash ?? null,
        ipfsUrl: input.ipfsUrl ?? null,
        recipientEmails: input.recipientEmails,
        status: input.status,
        errorMessage: input.errorMessage ?? null,
      })
      .returning();

    return record as GeneratedReport;
  } catch (error) {
    console.error("[Reports] Error recording generated report:", error);
    return null;
  }
};

export const getGeneratedReportsByEmployer = async (
  employerId: string,
  limit = 20,
): Promise<GeneratedReport[]> => {
  const db = getDb();
  if (!db) return [];

  return db
    .select()
    .from(generatedReports)
    .where(eq(generatedReports.employerId, employerId))
    .orderBy(desc(generatedReports.createdAt))
    .limit(limit) as Promise<GeneratedReport[]>;
};
