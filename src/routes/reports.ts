import { Router, Response } from "express";
import {
  authenticateRequest,
  requireUser,
  AuthenticatedRequest,
} from "../middleware/rbac";
import {
  createReportSchedule,
  getReportSchedulesByEmployer,
  deleteReportSchedule,
  getReportScheduleById,
  updateReportSchedule,
  getGeneratedReportsByEmployer,
  calculateNextSendDate,
} from "../db/payrollReportSchedule";
import { generateAndSendReport } from "../scheduler/reportScheduler";

export const reportsRouter = Router();

// Apply authentication to all routes
reportsRouter.use(authenticateRequest);

const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const validateAndFormatEmails = (
  emailInput: string | string[] | undefined,
): { valid: boolean; emailString?: string; error?: string } => {
  if (!emailInput) {
    return { valid: false, error: "Missing required field: email or emailTo" };
  }

  let emails: string[] = [];
  if (Array.isArray(emailInput)) {
    emails = emailInput.map((e) => String(e).trim()).filter(Boolean);
  } else if (typeof emailInput === "string") {
    emails = emailInput.split(",").map((e) => e.trim()).filter(Boolean);
  }

  if (emails.length === 0) {
    return { valid: false, error: "At least one valid email address is required" };
  }

  for (const email of emails) {
    if (!emailRegex.test(email)) {
      return { valid: false, error: `Invalid email format: ${email}` };
    }
  }

  return { valid: true, emailString: emails.join(", ") };
};

/**
 * POST /api/reports/schedule
 * Create a new payroll report schedule
 */
reportsRouter.post(
  "/schedule",
  requireUser,
  async (req: AuthenticatedRequest, res: Response): Promise<any> => {
    try {
      const {
        frequency,
        email,
        emailTo,
        dayOfMonth,
        dayOfWeek,
        includeSections,
        format,
        enabled,
      } = req.body;

      if (!frequency || (!email && !emailTo)) {
        return res.status(400).json({
          error: "Missing required fields: frequency, email (or emailTo)",
        });
      }

      const validFrequencies = ["weekly", "monthly", "quarterly"];
      if (!validFrequencies.includes(frequency)) {
        return res.status(400).json({
          error: "Invalid frequency. Must be 'weekly', 'monthly', or 'quarterly'",
        });
      }

      const emailValidation = validateAndFormatEmails(emailTo || email);
      if (!emailValidation.valid || !emailValidation.emailString) {
        return res.status(400).json({
          error: emailValidation.error || "Invalid email",
        });
      }

      if (
        dayOfMonth !== undefined &&
        dayOfMonth !== null &&
        (typeof dayOfMonth !== "number" || dayOfMonth < 1 || dayOfMonth > 31)
      ) {
        return res.status(400).json({
          error: "Invalid dayOfMonth. Must be an integer between 1 and 31",
        });
      }

      if (
        dayOfWeek !== undefined &&
        dayOfWeek !== null &&
        (typeof dayOfWeek !== "number" || dayOfWeek < 0 || dayOfWeek > 6)
      ) {
        return res.status(400).json({
          error: "Invalid dayOfWeek. Must be an integer between 0 and 6 (0 = Sunday)",
        });
      }

      const validFormats = ["pdf", "csv", "both"];
      if (format && !validFormats.includes(format)) {
        return res.status(400).json({
          error: "Invalid format. Must be 'pdf', 'csv', or 'both'",
        });
      }

      const employerId = req.user?.id || "unknown";

      const schedule = await createReportSchedule({
        employerId,
        frequency: frequency as "weekly" | "monthly" | "quarterly",
        email: emailValidation.emailString,
        dayOfMonth: dayOfMonth ?? (frequency === "weekly" ? null : 1),
        dayOfWeek: dayOfWeek ?? (frequency === "weekly" ? 1 : null),
        includeSections: includeSections ?? [
          "summary",
          "streams",
          "withdrawals",
          "vault_balance",
        ],
        format: (format as "pdf" | "csv" | "both") ?? "pdf",
        enabled: enabled ?? true,
      });

      res.status(201).json({
        message: "Report schedule created successfully",
        schedule,
      });
    } catch (error: any) {
      console.error("[Reports] Error creating schedule:", error.message);
      res.status(500).json({
        error: "Failed to create report schedule",
        details: error.message,
      });
    }
  },
);

/**
 * GET /api/reports/schedule
 * Get all report schedules for the authenticated user
 */
reportsRouter.get(
  "/schedule",
  requireUser,
  async (req: AuthenticatedRequest, res: Response): Promise<any> => {
    try {
      const employerId = req.user?.id || "unknown";

      const schedules = await getReportSchedulesByEmployer(employerId);

      res.json({ schedules });
    } catch (error: any) {
      console.error("[Reports] Error fetching schedules:", error.message);
      res.status(500).json({
        error: "Failed to fetch report schedules",
        details: error.message,
      });
    }
  },
);

/**
 * GET /api/reports/schedule/:id
 * Get a single report schedule by id
 */
reportsRouter.get(
  "/schedule/:id",
  requireUser,
  async (req: AuthenticatedRequest, res: Response): Promise<any> => {
    try {
      const { id } = req.params;
      const employerId = req.user?.id || "unknown";
      const scheduleId = parseInt(id, 10);

      const schedule = await getReportScheduleById(scheduleId);
      if (!schedule || schedule.employerId !== employerId) {
        return res.status(404).json({ error: "Report schedule not found" });
      }

      res.json({ schedule });
    } catch (error: any) {
      console.error("[Reports] Error fetching schedule:", error.message);
      res.status(500).json({
        error: "Failed to fetch schedule",
        details: error.message,
      });
    }
  },
);

/**
 * DELETE /api/reports/schedule/:id
 * Delete a report schedule
 */
reportsRouter.delete(
  "/schedule/:id",
  requireUser,
  async (req: AuthenticatedRequest, res: Response): Promise<any> => {
    try {
      const { id } = req.params;
      const employerId = req.user?.id || "unknown";
      const scheduleId = parseInt(id, 10);

      const schedule = await getReportScheduleById(scheduleId);

      if (!schedule) {
        return res.status(404).json({
          error: "Report schedule not found",
        });
      }

      // Verify ownership
      if (schedule.employerId !== employerId) {
        return res.status(403).json({
          error: "Not authorized to delete this schedule",
        });
      }

      const deletedSchedule = await deleteReportSchedule(
        scheduleId,
        employerId,
      );

      if (!deletedSchedule) {
        return res.status(404).json({
          error: "Report schedule not found",
        });
      }

      res.json({
        message: "Report schedule deleted successfully",
        schedule: deletedSchedule,
      });
    } catch (error: any) {
      console.error("[Reports] Error deleting schedule:", error.message);
      res.status(500).json({
        error: "Failed to delete report schedule",
        details: error.message,
      });
    }
  },
);

/**
 * PUT /api/reports/schedule/:id
 * Update a report schedule
 */
reportsRouter.put(
  "/schedule/:id",
  requireUser,
  async (req: AuthenticatedRequest, res: Response): Promise<any> => {
    try {
      const { id } = req.params;
      const employerId = req.user?.id || "unknown";
      const scheduleId = parseInt(id, 10);

      const existing = await getReportScheduleById(scheduleId);
      if (!existing || existing.employerId !== employerId) {
        return res.status(404).json({ error: "Report schedule not found" });
      }

      const {
        frequency,
        email,
        emailTo,
        dayOfMonth,
        dayOfWeek,
        includeSections,
        format,
        enabled,
      } = req.body;

      if (
        frequency &&
        !["weekly", "monthly", "quarterly"].includes(frequency)
      ) {
        return res.status(400).json({ error: "Invalid frequency" });
      }

      let formattedEmail: string | undefined;
      if (emailTo || email) {
        const emailValidation = validateAndFormatEmails(emailTo || email);
        if (!emailValidation.valid) {
          return res.status(400).json({ error: emailValidation.error });
        }
        formattedEmail = emailValidation.emailString;
      }

      if (
        dayOfMonth !== undefined &&
        dayOfMonth !== null &&
        (typeof dayOfMonth !== "number" || dayOfMonth < 1 || dayOfMonth > 31)
      ) {
        return res.status(400).json({
          error: "Invalid dayOfMonth. Must be between 1 and 31",
        });
      }

      if (
        dayOfWeek !== undefined &&
        dayOfWeek !== null &&
        (typeof dayOfWeek !== "number" || dayOfWeek < 0 || dayOfWeek > 6)
      ) {
        return res.status(400).json({
          error: "Invalid dayOfWeek. Must be between 0 and 6",
        });
      }

      if (format && !["pdf", "csv", "both"].includes(format)) {
        return res.status(400).json({ error: "Invalid format. Must be 'pdf', 'csv', or 'both'" });
      }

      const newFrequency = frequency ?? existing.frequency;
      const newDayOfMonth = dayOfMonth !== undefined ? dayOfMonth : existing.dayOfMonth;
      const newDayOfWeek = dayOfWeek !== undefined ? dayOfWeek : existing.dayOfWeek;

      const nextSendAt = calculateNextSendDate(
        newFrequency,
        newDayOfMonth,
        newDayOfWeek,
      );

      const updated = await updateReportSchedule(scheduleId, employerId, {
        ...(frequency && { frequency: frequency as "weekly" | "monthly" | "quarterly" }),
        ...(formattedEmail && { email: formattedEmail }),
        ...(dayOfMonth !== undefined && { dayOfMonth }),
        ...(dayOfWeek !== undefined && { dayOfWeek }),
        ...(includeSections && { includeSections }),
        ...(format && { format: format as "pdf" | "csv" | "both" }),
        ...(enabled !== undefined && { enabled }),
        nextSendAt,
      });

      res.json({ message: "Schedule updated", schedule: updated });
    } catch (error: any) {
      console.error("[Reports] Error updating schedule:", error.message);
      res.status(500).json({ error: "Failed to update schedule" });
    }
  },
);

/**
 * POST /api/reports/schedule/:id/test
 * Trigger an immediate test report for a schedule
 */
reportsRouter.post(
  "/schedule/:id/test",
  requireUser,
  async (req: AuthenticatedRequest, res: Response): Promise<any> => {
    try {
      const { id } = req.params;
      const employerId = req.user?.id || "unknown";
      const scheduleId = parseInt(id, 10);

      const schedule = await getReportScheduleById(scheduleId);
      if (!schedule || schedule.employerId !== employerId) {
        return res.status(404).json({ error: "Report schedule not found" });
      }

      const result = await generateAndSendReport(
        schedule.employerId,
        schedule.email,
        schedule.frequency,
        schedule.includeSections ?? [
          "summary",
          "streams",
          "withdrawals",
          "vault_balance",
        ],
        schedule.format ?? "pdf",
        schedule.id,
      );

      res.json({
        message: result.sent
          ? "Test report sent successfully"
          : "Report generated but email delivery failed",
        sent: result.sent,
        ipfsUrl: result.ipfsUrl,
        ipfsHash: result.ipfsHash,
      });
    } catch (error: any) {
      console.error("[Reports] Error sending test report:", error.message);
      res.status(500).json({ error: "Failed to send test report" });
    }
  },
);

/**
 * GET /api/reports/history
 * Get report generation history for authenticated employer
 */
reportsRouter.get(
  "/history",
  requireUser,
  async (req: AuthenticatedRequest, res: Response): Promise<any> => {
    try {
      const employerId = req.user?.id || "unknown";
      const history = await getGeneratedReportsByEmployer(employerId);
      res.json({ history });
    } catch (error: any) {
      console.error("[Reports] Error fetching history:", error.message);
      res.status(500).json({ error: "Failed to fetch report history" });
    }
  },
);

