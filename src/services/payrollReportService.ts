import axios from "axios";
import { PayrollReportData } from "./reportDataService";

const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY || "";
const SENDGRID_FROM_EMAIL =
  process.env.SENDGRID_FROM_EMAIL || "reports@quipay.app";

export interface SendReportEmailOptions {
  to: string | string[];
  subject: string;
  html: string;
  pdfBuffer?: Buffer | null;
  csvBuffer?: Buffer | null;
}

export { PayrollReportData };

/**
 * Parse single string, comma-separated list, or array of email addresses
 */
export const parseRecipientEmails = (emailInput: string | string[]): string[] => {
  if (Array.isArray(emailInput)) {
    return emailInput.map((e) => e.trim()).filter((e) => e.length > 0);
  }
  return emailInput
    .split(",")
    .map((e) => e.trim())
    .filter((e) => e.length > 0);
};

/**
 * Generate CSV report buffer from PayrollReportData
 */
export const generatePayrollReportCsv = (report: PayrollReportData): Buffer => {
  const lines: string[] = [];
  const escapeCsv = (val: string | number | undefined | null): string => {
    if (val === undefined || val === null) return '""';
    const s = String(val).replace(/"/g, '""');
    return `"${s}"`;
  };

  // 1. Report Metadata
  lines.push("PAYROLL REPORT");
  lines.push(`Employer ID,${escapeCsv(report.employerId)}`);
  if (report.employerName) {
    lines.push(`Company Name,${escapeCsv(report.employerName)}`);
  }
  lines.push(`Period Start,${escapeCsv(report.periodStart.toISOString().split("T")[0])}`);
  lines.push(`Period End,${escapeCsv(report.periodEnd.toISOString().split("T")[0])}`);
  lines.push(`Generated At,${escapeCsv(new Date().toISOString())}`);
  lines.push("");

  // 2. Summary
  lines.push("SUMMARY");
  lines.push(`Total Paid (XLM),${(parseFloat(report.totalPaid) / 1e7).toFixed(2)}`);
  lines.push(`Active Streams,${report.activeStreams}`);
  lines.push(`Completed Streams,${report.completedStreams}`);
  lines.push(`Workers Paid,${report.workers.length}`);
  lines.push(`Vault Balance (XLM),${(parseFloat(report.vaultActivity.currentBalance) / 1e7).toFixed(2)}`);
  if (report.vaultActivity.runwayEstimate) {
    lines.push(`Runway Estimate,${escapeCsv(report.vaultActivity.runwayEstimate)}`);
  }
  lines.push("");

  // 3. Worker Payouts
  lines.push("WORKER PAYOUTS");
  lines.push("Worker Address,Amount Paid (XLM),Stream Count,Flow Rate");
  for (const w of report.workers) {
    const amountXlm = (parseFloat(w.totalReceived) / 1e7).toFixed(2);
    lines.push(`${escapeCsv(w.workerAddress)},${amountXlm},${w.streamCount},${escapeCsv(w.flowRate || "N/A")}`);
  }
  lines.push("");

  // 4. Vault Activity
  lines.push("VAULT ACTIVITY");
  lines.push(`Total Deposits (XLM),${(parseFloat(report.vaultActivity.totalDeposits) / 1e7).toFixed(2)}`);
  lines.push(`Total Disbursed (XLM),${(parseFloat(report.vaultActivity.totalDisbursed) / 1e7).toFixed(2)}`);
  lines.push(`Current Balance (XLM),${(parseFloat(report.vaultActivity.currentBalance) / 1e7).toFixed(2)}`);
  lines.push("");

  // 5. Stream Events
  if (report.streamEvents && report.streamEvents.length > 0) {
    lines.push("STREAM EVENTS");
    lines.push("Date,Event Type,Stream ID,Worker Address,Details");
    for (const e of report.streamEvents) {
      lines.push(`${escapeCsv(e.timestamp.toISOString().split("T")[0])},${escapeCsv(e.eventType)},${e.streamId},${escapeCsv(e.workerAddress)},${escapeCsv(e.details || "")}`);
    }
  }

  return Buffer.from(lines.join("\n"), "utf-8");
};

/**
 * Send email with multiple attachments (PDF, CSV, or both) using SendGrid
 */
export const sendReportEmailWithAttachments = async (
  options: SendReportEmailOptions,
): Promise<boolean> => {
  const { to, subject, html, pdfBuffer, csvBuffer } = options;

  if (!SENDGRID_API_KEY) {
    console.warn("[Email] SendGrid API key not configured, skipping email");
    return false;
  }

  const recipients = parseRecipientEmails(to);
  if (recipients.length === 0) {
    console.warn("[Email] No valid recipients provided");
    return false;
  }

  const attachments: Array<{
    content: string;
    filename: string;
    type: string;
    disposition: string;
  }> = [];

  const dateStr = new Date().toISOString().slice(0, 10);

  if (pdfBuffer) {
    attachments.push({
      content: pdfBuffer.toString("base64"),
      filename: `payroll-report-${dateStr}.pdf`,
      type: "application/pdf",
      disposition: "attachment",
    });
  }

  if (csvBuffer) {
    attachments.push({
      content: csvBuffer.toString("base64"),
      filename: `payroll-report-${dateStr}.csv`,
      type: "text/csv",
      disposition: "attachment",
    });
  }

  try {
    await axios.post(
      "https://api.sendgrid.com/v3/mail/send",
      {
        personalizations: [
          {
            to: recipients.map((email) => ({ email })),
            subject,
          },
        ],
        from: { email: SENDGRID_FROM_EMAIL, name: "Quipay Payroll" },
        content: [{ type: "text/html", value: html }],
        attachments: attachments.length > 0 ? attachments : undefined,
      },
      {
        headers: {
          Authorization: `Bearer ${SENDGRID_API_KEY}`,
          "Content-Type": "application/json",
        },
      },
    );

    console.log(`[Email] Report email sent to ${recipients.join(", ")}`);
    return true;
  } catch (error: any) {
    console.error(`[Email] Failed to send report email:`, error.message);
    throw error;
  }
};

/**
 * Send email with optional PDF attachment using SendGrid (backward compatibility)
 */
export const sendReportEmailWithAttachment = async (
  to: string,
  subject: string,
  html: string,
  pdfBuffer: Buffer | null,
  csvBuffer: Buffer | null = null,
): Promise<boolean> => {
  return sendReportEmailWithAttachments({
    to,
    subject,
    html,
    pdfBuffer,
    csvBuffer,
  });
};

/**
 * Send payroll report via email using SendGrid (legacy helper)
 */
export const sendPayrollReportEmail = async (
  to: string,
  report: PayrollReportData,
): Promise<boolean> => {
  if (!SENDGRID_API_KEY) {
    console.warn("[Email] SendGrid API key not configured, skipping email");
    return false;
  }

  try {
    const htmlContent = generateReportHTML(report);

    await axios.post(
      "https://api.sendgrid.com/v3/mail/send",
      {
        personalizations: [
          {
            to: [{ email: to }],
            subject: `Payroll Report - ${report.periodStart.toLocaleDateString()} to ${report.periodEnd.toLocaleDateString()}`,
          },
        ],
        from: { email: SENDGRID_FROM_EMAIL, name: "Quipay Payroll" },
        content: [{ type: "text/html", value: htmlContent }],
      },
      {
        headers: {
          Authorization: `Bearer ${SENDGRID_API_KEY}`,
          "Content-Type": "application/json",
        },
      },
    );

    console.log(`[Email] Payroll report sent to ${to}`);
    return true;
  } catch (error: any) {
    console.error(`[Email] Failed to send payroll report:`, error.message);
    return false;
  }
};

/**
 * Generate HTML report for email
 */
const generateReportHTML = (report: PayrollReportData): string => {
  const workerRows = report.workers
    .map(
      (w) => `
      <tr>
        <td style="padding: 8px; border: 1px solid #ddd;">${w.workerAddress.slice(0, 6)}...${w.workerAddress.slice(-4)}</td>
        <td style="padding: 8px; border: 1px solid #ddd;">${w.totalReceived}</td>
        <td style="padding: 8px; border: 1px solid #ddd;">${w.streamCount}</td>
      </tr>
    `,
    )
    .join("");

  return `
<!DOCTYPE html>
<html>
<head>
  <style>
    body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
    .container { max-width: 600px; margin: 0 auto; padding: 20px; }
    .header { background: #007bff; color: white; padding: 20px; text-align: center; }
    .summary { background: #f8f9fa; padding: 15px; margin: 20px 0; border-radius: 5px; }
    table { width: 100%; border-collapse: collapse; margin: 20px 0; }
    th { background: #007bff; color: white; padding: 10px; text-align: left; }
    .footer { margin-top: 30px; padding-top: 20px; border-top: 1px solid #ddd; font-size: 12px; color: #666; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>Payroll Report</h1>
      <p>${report.periodStart.toLocaleDateString()} - ${report.periodEnd.toLocaleDateString()}</p>
    </div>
    
    <div class="summary">
      <h2>Summary</h2>
      <p><strong>Total Paid:</strong> ${report.totalPaid} XLM</p>
      <p><strong>Active Streams:</strong> ${report.activeStreams}</p>
      <p><strong>Completed Streams:</strong> ${report.completedStreams}</p>
    </div>
    
    <h2>Worker Breakdown</h2>
    <table>
      <thead>
        <tr>
          <th>Worker</th>
          <th>Total Received</th>
          <th>Streams</th>
        </tr>
      </thead>
      <tbody>
        ${workerRows}
      </tbody>
    </table>
    
    <div class="footer">
      <p>This is an automated report from Quipay Payroll System.</p>
      <p>To unsubscribe from these reports, please contact your administrator.</p>
    </div>
  </div>
</body>
</html>
  `.trim();
};

