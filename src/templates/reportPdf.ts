import PDFDocument from "pdfkit";
import axios from "axios";
import fs from "fs/promises";
import { BrandingSettings } from "../services/pdfGeneratorService";
import { PayrollReportData } from "../services/reportDataService";

const DEFAULT_PRIMARY_COLOR = "#2563eb";
const DEFAULT_SECONDARY_COLOR = "#64748b";

export interface PayrollReportPdfOptions {
  report: PayrollReportData;
  branding: BrandingSettings;
  ipfsCid?: string;
  includeSections?: string[];
}

function formatAmount(amount: string): string {
  const xlm = parseFloat(amount) / 10000000;
  if (!Number.isFinite(xlm)) return "0.00 XLM";
  return `${xlm.toFixed(4)} XLM`;
}

function formatAmountShort(amount: string): string {
  const xlm = parseFloat(amount) / 10000000;
  if (!Number.isFinite(xlm)) return "0.00 XLM";
  return `${xlm.toFixed(2)} XLM`;
}

/**
 * Generate a payroll report PDF buffer with branding, summary, tables, and verifiable footer.
 */
export async function buildPayrollReportPdf(
  options: PayrollReportPdfOptions,
): Promise<Buffer> {
  const { report, branding, ipfsCid, includeSections = ["summary", "streams", "withdrawals", "vault_balance"] } = options;

  return new Promise(async (resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: "A4",
        margin: 50,
        bufferPages: true,
      });

      const chunks: Buffer[] = [];
      doc.on("data", (chunk) => chunks.push(chunk));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);

      // Fetch logo if configured
      let logoBuffer: Buffer | null = null;
      if (branding.logoUrl) {
        try {
          if (
            branding.logoUrl.startsWith("http://") ||
            branding.logoUrl.startsWith("https://")
          ) {
            const response = await axios.get<ArrayBuffer>(branding.logoUrl, {
              responseType: "arraybuffer",
              timeout: 5000,
            });
            logoBuffer = Buffer.from(response.data);
          } else {
            logoBuffer = await fs.readFile(branding.logoUrl);
          }
        } catch {
          // Logo fetch failed — continue without it
        }
      }

      const primary = branding.primaryColor || DEFAULT_PRIMARY_COLOR;
      const secondary = branding.secondaryColor || DEFAULT_SECONDARY_COLOR;

      // ── Header ──
      addReportHeader(doc, primary, secondary, logoBuffer, report);

      // ── Summary Section ──
      if (includeSections.includes("summary")) {
        addReportSummary(doc, report, primary);
      }

      // ── Payouts Table (withdrawals) ──
      if (includeSections.includes("withdrawals") || includeSections.includes("summary")) {
        addPayoutsTable(doc, report.workers, primary);
      }

      // ── Vault Activity (vault_balance) ──
      if (includeSections.includes("vault_balance")) {
        addVaultActivity(doc, report.vaultActivity, primary);
      }

      // ── Stream Events (streams) ──
      if (includeSections.includes("streams") && report.streamEvents.length > 0) {
        addStreamEvents(doc, report.streamEvents, primary);
      }

      // ── Footer & Page Numbers ──
      const range = doc.bufferedPageRange();
      for (let i = range.start; i < range.start + range.count; i++) {
        doc.switchToPage(i);
        addReportFooter(doc, i + 1, range.count, ipfsCid);
      }

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

function addReportHeader(
  doc: PDFKit.PDFDocument,
  primary: string,
  secondary: string,
  logoBuffer: Buffer | null,
  report: PayrollReportData,
): void {
  const companyName = report.employerName || "Quipay Payroll";

  if (logoBuffer) {
    try {
      doc.image(logoBuffer, 50, 40, { width: 70, height: 40, fit: [70, 40] });
    } catch {
      doc.fontSize(14).fillColor(primary).text(companyName, 50, 45);
    }
  } else {
    doc.fontSize(16).fillColor(primary).text(companyName, 50, 45);
  }

  doc
    .fontSize(18)
    .fillColor(primary)
    .text("Payroll Summary Report", 200, 40, { align: "right" });

  const periodStr = `${report.periodStart.toLocaleDateString()} — ${report.periodEnd.toLocaleDateString()}`;
  doc
    .fontSize(9)
    .fillColor(secondary)
    .text(`Period: ${periodStr}`, 200, 62, { align: "right" })
    .text(`Generated: ${new Date().toLocaleDateString()}`, 200, 75, { align: "right" });

  doc
    .moveTo(50, 95)
    .lineTo(545, 95)
    .strokeColor(primary)
    .lineWidth(1.5)
    .stroke()
    .moveDown(2);

  doc.y = 110;
}

function addReportSummary(
  doc: PDFKit.PDFDocument,
  report: PayrollReportData,
  primary: string,
): void {
  checkPageOverflow(doc, 130);

  doc.fontSize(13).fillColor(primary).text("Executive Summary").moveDown(0.4);

  const startY = doc.y;
  const leftX = 50;
  const lineH = 20;

  const rows: [string, string][] = [
    ["Total Paid in Period", `${formatAmountShort(report.totalPaid)}`],
    ["Active Payroll Streams", report.activeStreams.toString()],
    ["Completed Streams", report.completedStreams.toString()],
    ["Workers Paid", report.workers.length.toString()],
    ["Vault Balance", `${formatAmountShort(report.vaultActivity.currentBalance)}`],
    ["Runway Estimate", report.vaultActivity.runwayEstimate || "N/A"],
  ];

  rows.forEach(([label, value], i) => {
    const y = startY + i * lineH;
    doc
      .fontSize(9)
      .fillColor("#666666")
      .text(label, leftX, y)
      .fillColor("#111827")
      .text(value, leftX + 160, y);
  });

  doc.y = startY + rows.length * lineH + 15;
}

function addPayoutsTable(
  doc: PDFKit.PDFDocument,
  workers: PayrollReportData["workers"],
  primary: string,
): void {
  checkPageOverflow(doc, 120);

  doc.fontSize(13).fillColor(primary).text("Payouts by Worker").moveDown(0.4);

  if (workers.length === 0) {
    doc
      .fontSize(9)
      .fillColor("#666666")
      .text("No payouts recorded in this period.")
      .moveDown(1.5);
    return;
  }

  const tableTop = doc.y;
  const leftMargin = 50;
  const cols = { worker: 180, stream: 75, amount: 120, flowRate: 120 };

  // Header row
  doc
    .fontSize(9)
    .fillColor("#FFFFFF")
    .rect(leftMargin, tableTop, 495, 20)
    .fill(primary);

  doc
    .fillColor("#FFFFFF")
    .text("Worker Address", leftMargin + 6, tableTop + 5, { width: cols.worker })
    .text("Stream ID", leftMargin + cols.worker + 6, tableTop + 5, { width: cols.stream })
    .text("Paid in Period", leftMargin + cols.worker + cols.stream + 6, tableTop + 5, { width: cols.amount })
    .text("Flow Rate", leftMargin + cols.worker + cols.stream + cols.amount + 6, tableTop + 5, { width: cols.flowRate });

  let currentY = tableTop + 20;
  workers.forEach((w, i) => {
    checkPageOverflow(doc, 25);
    if (doc.y > currentY) {
      currentY = doc.y;
    }

    const bg = i % 2 === 0 ? "#F9FAFB" : "#FFFFFF";
    doc.rect(leftMargin, currentY, 495, 20).fill(bg);

    const shortAddr = `${w.workerAddress.slice(0, 8)}…${w.workerAddress.slice(-6)}`;
    const streamIdStr = w.streamId ? `#${w.streamId}` : `(${w.streamCount} streams)`;
    const flowRateStr = w.flowRate || "—";

    doc
      .fillColor("#111827")
      .fontSize(8.5)
      .text(shortAddr, leftMargin + 6, currentY + 5, { width: cols.worker })
      .text(streamIdStr, leftMargin + cols.worker + 6, currentY + 5, { width: cols.stream })
      .text(formatAmount(w.totalReceived), leftMargin + cols.worker + cols.stream + 6, currentY + 5, { width: cols.amount })
      .text(flowRateStr, leftMargin + cols.worker + cols.stream + cols.amount + 6, currentY + 5, { width: cols.flowRate });

    currentY += 20;
  });

  doc.y = currentY + 15;
}

function addVaultActivity(
  doc: PDFKit.PDFDocument,
  vault: PayrollReportData["vaultActivity"],
  primary: string,
): void {
  checkPageOverflow(doc, 110);

  doc.fontSize(13).fillColor(primary).text("Vault & Runway Activity").moveDown(0.4);

  const startY = doc.y;
  const leftX = 50;
  const lineH = 20;

  const rows: [string, string][] = [
    ["Deposits Received in Period", formatAmountShort(vault.totalDeposits)],
    ["Total Disbursed in Period", formatAmountShort(vault.totalDisbursed)],
    ["Current Vault Balance", formatAmountShort(vault.currentBalance)],
    ["Estimated Runway", vault.runwayEstimate || "N/A"],
  ];

  rows.forEach(([label, value], i) => {
    const y = startY + i * lineH;
    doc
      .fontSize(9)
      .fillColor("#666666")
      .text(label, leftX, y)
      .fillColor("#111827")
      .text(value, leftX + 180, y);
  });

  doc.y = startY + rows.length * lineH + 15;
}

function addStreamEvents(
  doc: PDFKit.PDFDocument,
  events: PayrollReportData["streamEvents"],
  primary: string,
): void {
  checkPageOverflow(doc, 100);

  doc.fontSize(13).fillColor(primary).text("Stream Lifecycle Events").moveDown(0.4);

  const tableTop = doc.y;
  const leftMargin = 50;
  const cols = { date: 100, event: 110, stream: 90, worker: 195 };

  doc
    .fontSize(9)
    .fillColor("#FFFFFF")
    .rect(leftMargin, tableTop, 495, 20)
    .fill(primary);

  doc
    .fillColor("#FFFFFF")
    .text("Date", leftMargin + 6, tableTop + 5, { width: cols.date })
    .text("Event", leftMargin + cols.date + 6, tableTop + 5, { width: cols.event })
    .text("Stream ID", leftMargin + cols.date + cols.event + 6, tableTop + 5, { width: cols.stream })
    .text("Worker / Details", leftMargin + cols.date + cols.event + cols.stream + 6, tableTop + 5, { width: cols.worker });

  let currentY = tableTop + 20;
  events.forEach((e, i) => {
    checkPageOverflow(doc, 25);
    if (doc.y > currentY) {
      currentY = doc.y;
    }

    const bg = i % 2 === 0 ? "#F9FAFB" : "#FFFFFF";
    doc.rect(leftMargin, currentY, 495, 20).fill(bg);

    const targetInfo = e.workerAddress
      ? `${e.workerAddress.slice(0, 8)}…${e.workerAddress.slice(-6)}`
      : e.details || "—";

    doc
      .fillColor("#111827")
      .fontSize(8.5)
      .text(e.timestamp.toLocaleDateString(), leftMargin + 6, currentY + 5, { width: cols.date })
      .text(e.eventType, leftMargin + cols.date + 6, currentY + 5, { width: cols.event })
      .text(`#${e.streamId}`, leftMargin + cols.date + cols.event + 6, currentY + 5, { width: cols.stream })
      .text(targetInfo, leftMargin + cols.date + cols.event + cols.stream + 6, currentY + 5, { width: cols.worker });

    currentY += 20;
  });

  doc.y = currentY + 15;
}

function checkPageOverflow(doc: PDFKit.PDFDocument, requiredHeight: number): void {
  const bottomMargin = 70;
  if (doc.y + requiredHeight > doc.page.height - bottomMargin) {
    doc.addPage();
    doc.y = 50;
  }
}

function addReportFooter(
  doc: PDFKit.PDFDocument,
  pageNumber: number,
  totalPages: number,
  ipfsCid?: string,
): void {
  const pageHeight = doc.page.height;

  // Thin separator line
  doc
    .moveTo(50, pageHeight - 55)
    .lineTo(545, pageHeight - 55)
    .strokeColor("#E5E7EB")
    .lineWidth(0.8)
    .stroke();

  let footerLeft = "Powered by Quipay — Verifiable Continuous Payroll on Stellar";
  if (ipfsCid) {
    footerLeft += ` | IPFS CID: ${ipfsCid.slice(0, 12)}…${ipfsCid.slice(-6)}`;
  }

  doc
    .fontSize(7.5)
    .fillColor("#6B7280")
    .text(footerLeft, 50, pageHeight - 45, { width: 380 });

  doc
    .fontSize(7.5)
    .fillColor("#6B7280")
    .text(`Page ${pageNumber} of ${totalPages}`, 430, pageHeight - 45, {
      align: "right",
      width: 115,
    });
}
