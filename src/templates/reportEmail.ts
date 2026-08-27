import { PayrollReportData } from "../services/reportDataService";

const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");

const formatTokens = (amount: string): string => {
  const num = parseFloat(amount);
  return Number.isFinite(num) ? (num / 1e7).toFixed(2) : "0.00";
};

const baseLayout = (title: string, body: string): string => `
  <div style="font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif; line-height: 1.5; max-width: 600px; margin: 0 auto; background: #ffffff; border-radius: 8px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.1);">
    <div style="background: #2563eb; color: white; padding: 24px; text-align: left;">
      <h1 style="margin: 0; font-size: 20px; font-weight: 700;">${escapeHtml(title)}</h1>
      <p style="margin: 6px 0 0; font-size: 13px; opacity: 0.9;">Continuous Payroll on Stellar</p>
    </div>
    <div style="background: #ffffff; padding: 24px; border-left: 1px solid #e5e7eb; border-right: 1px solid #e5e7eb;">
      ${body}
    </div>
    <div style="background: #f9fafb; padding: 16px 24px; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 8px 8px; font-size: 12px; color: #6b7280; text-align: center;">
      <p style="margin: 0 0 4px;">This is an automated report from Quipay Payroll System.</p>
      <p style="margin: 0;">
        <a href="https://quipay.app/settings/notifications" style="color: #6b7280; text-decoration: underline;">Unsubscribe / Manage schedule settings</a>
      </p>
    </div>
  </div>
`;

export const renderPayrollReportEmail = (
  report: PayrollReportData,
  ipfsUrl?: string,
): { subject: string; html: string } => {
  const periodLabel = `${report.periodStart.toLocaleDateString()} — ${report.periodEnd.toLocaleDateString()}`;
  const monthName = report.periodEnd.toLocaleString("default", { month: "long" });

  const workerRows = report.workers
    .map(
      (w) => `
      <tr>
        <td style="padding: 8px 12px; border-bottom: 1px solid #f3f4f6; font-family: monospace; font-size: 13px;">
          ${escapeHtml(`${w.workerAddress.slice(0, 6)}…${w.workerAddress.slice(-4)}`)}
        </td>
        <td style="padding: 8px 12px; border-bottom: 1px solid #f3f4f6; text-align: right; font-weight: 500;">
          ${escapeHtml(formatTokens(w.totalReceived))} XLM
        </td>
        <td style="padding: 8px 12px; border-bottom: 1px solid #f3f4f6; text-align: center;">
          ${w.streamCount}
        </td>
      </tr>
    `,
    )
    .join("");

  const body = `
    <h2 style="font-size: 16px; color: #111827; margin: 0 0 8px;">
      Your ${escapeHtml(monthName)} payroll report is ready
    </h2>
    <p style="color: #4b5563; font-size: 14px; margin: 0 0 20px;">
      Here is your automated payroll summary for <strong>${escapeHtml(periodLabel)}</strong>.
    </p>

    <div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 16px; margin: 0 0 20px;">
      <h3 style="font-size: 13px; text-transform: uppercase; letter-spacing: 0.5px; color: #64748b; margin: 0 0 12px;">Key Summary Stats</h3>
      <table style="width: 100%; border-collapse: collapse;">
        <tr>
          <td style="padding: 6px 0; color: #475569; font-size: 13px;">Total Paid</td>
          <td style="padding: 6px 0; text-align: right; font-weight: 700; color: #0f172a; font-size: 14px;">
            ${escapeHtml(formatTokens(report.totalPaid))} XLM
          </td>
        </tr>
        <tr>
          <td style="padding: 6px 0; color: #475569; font-size: 13px;">Workers Paid</td>
          <td style="padding: 6px 0; text-align: right; font-weight: 600; color: #0f172a;">
            ${report.workers.length}
          </td>
        </tr>
        <tr>
          <td style="padding: 6px 0; color: #475569; font-size: 13px;">Active Streams</td>
          <td style="padding: 6px 0; text-align: right; font-weight: 600; color: #0f172a;">
            ${report.activeStreams}
          </td>
        </tr>
        <tr>
          <td style="padding: 6px 0; color: #475569; font-size: 13px;">Vault Balance</td>
          <td style="padding: 6px 0; text-align: right; font-weight: 600; color: #0f172a;">
            ${escapeHtml(formatTokens(report.vaultActivity.currentBalance))} XLM
          </td>
        </tr>
        ${
          report.vaultActivity.runwayEstimate
            ? `
        <tr>
          <td style="padding: 6px 0; color: #475569; font-size: 13px;">Estimated Runway</td>
          <td style="padding: 6px 0; text-align: right; font-weight: 600; color: #0f172a;">
            ${escapeHtml(report.vaultActivity.runwayEstimate)}
          </td>
        </tr>
        `
            : ""
        }
      </table>
    </div>

    ${
      report.workers.length > 0
        ? `
    <h3 style="font-size: 14px; color: #374151; margin: 0 0 8px;">Worker Payouts</h3>
    <table style="width: 100%; border-collapse: collapse; margin: 0 0 20px;">
      <thead>
        <tr style="background: #2563eb; color: white;">
          <th style="padding: 8px 12px; text-align: left; font-size: 12px; font-weight: 600;">Worker</th>
          <th style="padding: 8px 12px; text-align: right; font-size: 12px; font-weight: 600;">Amount</th>
          <th style="padding: 8px 12px; text-align: center; font-size: 12px; font-weight: 600;">Streams</th>
        </tr>
      </thead>
      <tbody>
        ${workerRows}
      </tbody>
    </table>
    `
        : '<p style="color: #9ca3af; font-style: italic; margin-bottom: 20px;">No payouts recorded in this period.</p>'
    }

    ${
      ipfsUrl
        ? `
    <div style="background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 8px; padding: 14px 16px; margin: 0 0 20px;">
      <p style="margin: 0 0 8px; font-size: 13px; color: #166534; font-weight: 600;">
        Verifiable IPFS Audit Record
      </p>
      <p style="margin: 0; font-size: 12px;">
        <a href="${escapeHtml(ipfsUrl)}" target="_blank" rel="noopener noreferrer" style="display: inline-block; background: #16a34a; color: white; padding: 6px 12px; border-radius: 4px; text-decoration: none; font-weight: 500; margin-right: 8px;">
          View on IPFS
        </a>
        <span style="color: #4b5563; font-size: 11px;">Immutable cryptographic proof</span>
      </p>
    </div>
    `
        : ""
    }

    <p style="color: #6b7280; font-size: 13px; margin: 16px 0 0; padding-top: 12px; border-top: 1px solid #e5e7eb;">
      📎 <strong>Attachment:</strong> The full detailed report is attached to this email.
    </p>
  `;

  return {
    subject: `Payroll Report — ${periodLabel}`,
    html: baseLayout("Payroll Report", body),
  };
};

