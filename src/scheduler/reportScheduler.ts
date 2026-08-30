import * as cron from "node-cron";
import {
  getEnabledSchedulesDue,
  updateReportScheduleLastSent,
  calculateNextSendDate,
  recordGeneratedReport,
  updateReportSchedule,
} from "../db/payrollReportSchedule";
import {
  sendReportEmailWithAttachments,
  generatePayrollReportCsv,
} from "../services/payrollReportService";
import { generateReportData } from "../services/reportDataService";
import {
  generatePayrollReport,
  PayrollReportPdfData,
  BrandingSettings,
} from "../services/pdfGeneratorService";
import { getBrandingForEmployer } from "../services/brandingService";
import { pinProofToIPFS } from "../services/ipfsService";
import { renderPayrollReportEmail } from "../templates/reportEmail";
import { serviceLogger } from "../audit/serviceLogger";

const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 1000;

export { calculateNextSendDate };

/**
 * Sleep helper for retry backoff
 */
const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Generate and send a single report with retry logic.
 */
export const generateAndSendReport = async (
  employerId: string,
  email: string,
  frequency: string,
  includeSections: string[],
  format: string,
  scheduleId?: number,
): Promise<{ sent: boolean; ipfsUrl?: string; ipfsHash?: string }> => {
  // Calculate reporting period based on frequency
  const now = new Date();
  const periodEnd = new Date(now);
  const periodStart = new Date(now);

  if (frequency === "weekly") {
    periodStart.setDate(now.getDate() - 7);
  } else if (frequency === "quarterly") {
    periodStart.setMonth(now.getMonth() - 3);
  } else {
    // monthly default
    periodStart.setMonth(now.getMonth() - 1);
  }

  // 1. Query report data
  const reportData = await generateReportData(
    employerId,
    periodStart,
    periodEnd,
    frequency,
  );

  // 2. Get employer branding
  let branding: BrandingSettings;
  try {
    branding = await getBrandingForEmployer(employerId);
  } catch {
    branding = {
      logoUrl: null,
      primaryColor: "#2563eb",
      secondaryColor: "#64748b",
    };
  }

  // 3. Pin metadata to IPFS for immutable record-keeping
  let ipfsUrl: string | undefined;
  let ipfsHash: string | undefined;
  try {
    const proof = {
      schemaVersion: "1.0",
      streamId: 0,
      employer_address: employerId,
      worker_address: "",
      tokenAddress: "native",
      tokenSymbol: "XLM",
      totalAmount: reportData.totalPaid,
      withdrawnAmount: "0",
      startTs: Math.floor(periodStart.getTime() / 1000),
      endTs: Math.floor(periodEnd.getTime() / 1000),
      closedAt: null,
      txHash: null,
      generatedAt: now.toISOString(),
      network: "stellar",
      contractId: "",
    };
    const pinResult = await pinProofToIPFS(proof as any);
    ipfsUrl = pinResult.gatewayUrl;
    ipfsHash = pinResult.cid;
  } catch (err) {
    await serviceLogger.warn(
      "PayrollReport",
      "IPFS pinning failed, continuing without archive",
      { employerId, error: (err as Error).message },
    );
  }

  // 4. Generate PDF if format includes pdf
  let pdfBuffer: Buffer | null = null;
  if (format === "pdf" || format === "both") {
    const pdfData: PayrollReportPdfData = {
      employerId: reportData.employerId,
      employerName: reportData.employerName,
      periodStart: reportData.periodStart,
      periodEnd: reportData.periodEnd,
      totalPaid: reportData.totalPaid,
      activeStreams: reportData.activeStreams,
      completedStreams: reportData.completedStreams,
      totalFlowRate: reportData.totalFlowRate,
      workers: reportData.workers,
      vaultActivity: reportData.vaultActivity,
      streamEvents: reportData.streamEvents,
    };
    pdfBuffer = await generatePayrollReport(
      pdfData,
      branding,
      ipfsHash,
      includeSections,
    );
  }

  // 5. Generate CSV if format includes csv
  let csvBuffer: Buffer | null = null;
  if (format === "csv" || format === "both") {
    csvBuffer = generatePayrollReportCsv(reportData);
  }

  // 6. Build email
  const { subject, html } = renderPayrollReportEmail(reportData, ipfsUrl);

  // 7. Send with retry
  let sent = false;
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      sent = await sendReportEmailWithAttachments({
        to: email,
        subject,
        html,
        pdfBuffer,
        csvBuffer,
      });

      if (sent) {
        break;
      }
    } catch (err) {
      lastError = err as Error;
      await serviceLogger.warn(
        "PayrollReport",
        `Email delivery attempt ${attempt}/${MAX_RETRIES} failed`,
        { employerId, email, error: (err as Error).message },
      );

      if (attempt < MAX_RETRIES) {
        await sleep(RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1));
      }
    }
  }

  // 8. Record in generated_reports table
  await recordGeneratedReport({
    scheduleId,
    employerId,
    periodStart,
    periodEnd,
    frequency,
    format,
    includeSections,
    ipfsHash,
    ipfsUrl,
    recipientEmails: email,
    status: sent ? "success" : "failed",
    errorMessage: sent ? null : lastError?.message || "Delivery failed after retries",
  });

  return { sent, ipfsUrl, ipfsHash };
};

/**
 * Process scheduled payroll reports
 */
export const processScheduledReports = async (): Promise<void> => {
  try {
    const schedules = await getEnabledSchedulesDue();

    for (const schedule of schedules) {
      try {
        const { sent, ipfsUrl } = await generateAndSendReport(
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

        if (sent) {
          const nextSendAt = calculateNextSendDate(
            schedule.frequency,
            schedule.dayOfMonth,
            schedule.dayOfWeek,
          );
          await updateReportScheduleLastSent(schedule.id, nextSendAt);

          await serviceLogger.info(
            "PayrollReport",
            `Sent scheduled report to ${schedule.email}`,
            {
              scheduleId: schedule.id,
              employerId: schedule.employerId,
              frequency: schedule.frequency,
              ipfsUrl,
            },
          );
        } else {
          await serviceLogger.error(
            "PayrollReport",
            `All ${MAX_RETRIES} delivery attempts failed for schedule ${schedule.id}`,
            new Error("Email delivery failed after retries"),
            { scheduleId: schedule.id, employerId: schedule.employerId },
          );
        }
      } catch (error: any) {
        await serviceLogger.error(
          "PayrollReport",
          `Failed to generate report for schedule ${schedule.id}`,
          error,
          {
            scheduleId: schedule.id,
            employerId: schedule.employerId,
          },
        );
      }
    }
  } catch (error: any) {
    await serviceLogger.error(
      "PayrollReport",
      "Failed to process scheduled reports",
      error,
    );
  }
};

let reportCronJob: cron.ScheduledTask | null = null;

/**
 * Start the payroll report scheduler
 * Runs daily at midnight to check for due reports
 */
export const startPayrollReportScheduler = (): void => {
  if (reportCronJob) {
    console.log("[PayrollReportScheduler] Already running");
    return;
  }

  reportCronJob = cron.schedule("0 0 * * *", async () => {
    console.log("[PayrollReportScheduler] Processing scheduled reports...");
    await processScheduledReports();
  });

  console.log("[PayrollReportScheduler] Started - runs daily at midnight");
};

/**
 * Stop the payroll report scheduler
 */
export const stopPayrollReportScheduler = (): void => {
  if (reportCronJob) {
    reportCronJob.stop();
    reportCronJob = null;
    console.log("[PayrollReportScheduler] Stopped");
  }
};
