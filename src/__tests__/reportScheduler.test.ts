import {
  generateAndSendReport,
  processScheduledReports,
  calculateNextSendDate,
} from "../scheduler/reportScheduler";
import * as reportDataService from "../services/reportDataService";
import * as pdfGeneratorService from "../services/pdfGeneratorService";
import * as brandingService from "../services/brandingService";
import * as ipfsService from "../services/ipfsService";
import * as reportEmail from "../templates/reportEmail";
import * as payrollReportService from "../services/payrollReportService";
import * as payrollReportScheduleDb from "../db/payrollReportSchedule";
import * as serviceLogger from "../audit/serviceLogger";

jest.mock("../services/reportDataService");
jest.mock("../services/pdfGeneratorService");
jest.mock("../services/brandingService");
jest.mock("../services/ipfsService");
jest.mock("../templates/reportEmail");
jest.mock("../services/payrollReportService");
jest.mock("../db/payrollReportSchedule", () => {
  const actual = jest.requireActual("../db/payrollReportSchedule");
  return {
    ...actual,
    createReportSchedule: jest.fn(),
    getReportSchedulesByEmployer: jest.fn(),
    getReportScheduleById: jest.fn(),
    updateReportSchedule: jest.fn(),
    updateReportScheduleLastSent: jest.fn(),
    deleteReportSchedule: jest.fn(),
    getEnabledSchedulesDue: jest.fn(),
    recordGeneratedReport: jest.fn(),
    getGeneratedReportsByEmployer: jest.fn(),
  };
});
jest.mock("../audit/serviceLogger", () => ({
  serviceLogger: {
    info: jest.fn().mockResolvedValue(undefined),
    warn: jest.fn().mockResolvedValue(undefined),
    error: jest.fn().mockResolvedValue(undefined),
  },
}));

const mockReportData = {
  employerId: "emp-1",
  periodStart: new Date("2026-01-01"),
  periodEnd: new Date("2026-01-31"),
  totalPaid: "1000000000",
  activeStreams: 3,
  completedStreams: 5,
  workers: [
    { workerAddress: "GABC123", totalReceived: "500000000", streamCount: 2 },
  ],
  vaultActivity: {
    totalDeposits: "2000000000",
    totalDisbursed: "1000000000",
    currentBalance: "1000000000",
    runwayEstimate: "3.5 months",
  },
  streamEvents: [],
};

beforeEach(() => {
  jest.clearAllMocks();
  (reportDataService.generateReportData as jest.Mock).mockResolvedValue(
    mockReportData,
  );
  (brandingService.getBrandingForEmployer as jest.Mock).mockResolvedValue({
    logoUrl: null,
    primaryColor: "#2563eb",
    secondaryColor: "#64748b",
  });
  (pdfGeneratorService.generatePayrollReport as jest.Mock).mockResolvedValue(
    Buffer.from("pdf"),
  );
  (payrollReportService.generatePayrollReportCsv as jest.Mock).mockReturnValue(
    Buffer.from("csv,data"),
  );
  (ipfsService.pinProofToIPFS as jest.Mock).mockResolvedValue({
    gatewayUrl: "https://ipfs.io/ipfs/QmTest",
    cid: "QmTest",
  });
  (reportEmail.renderPayrollReportEmail as jest.Mock).mockReturnValue({
    subject: "Test Report",
    html: "<p>Test</p>",
  });
  (payrollReportScheduleDb.recordGeneratedReport as jest.Mock).mockResolvedValue({
    id: 1,
  });
});

describe("generateAndSendReport", () => {
  it("generates report data, PDF, pins to IPFS, and sends email", async () => {
    (
      payrollReportService.sendReportEmailWithAttachments as jest.Mock
    ).mockResolvedValue(true);

    const result = await generateAndSendReport(
      "emp-1",
      "test@example.com",
      "monthly",
      ["summary"],
      "pdf",
      1,
    );

    expect(result.sent).toBe(true);
    expect(result.ipfsUrl).toContain("ipfs");
    expect(result.ipfsHash).toBe("QmTest");
    expect(reportDataService.generateReportData).toHaveBeenCalledWith(
      "emp-1",
      expect.any(Date),
      expect.any(Date),
      "monthly",
    );
    expect(pdfGeneratorService.generatePayrollReport).toHaveBeenCalled();
    expect(
      payrollReportService.sendReportEmailWithAttachments,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "test@example.com",
        subject: "Test Report",
        html: "<p>Test</p>",
        pdfBuffer: expect.any(Buffer),
      }),
    );
    expect(payrollReportScheduleDb.recordGeneratedReport).toHaveBeenCalledWith(
      expect.objectContaining({
        scheduleId: 1,
        employerId: "emp-1",
        status: "success",
      }),
    );
  });

  it("handles quarterly frequency with 3 month period", async () => {
    (
      payrollReportService.sendReportEmailWithAttachments as jest.Mock
    ).mockResolvedValue(true);

    const result = await generateAndSendReport(
      "emp-1",
      "test@example.com",
      "quarterly",
      ["summary"],
      "pdf",
    );

    expect(result.sent).toBe(true);
    expect(reportDataService.generateReportData).toHaveBeenCalledWith(
      "emp-1",
      expect.any(Date),
      expect.any(Date),
      "quarterly",
    );
  });

  it("generates both PDF and CSV when format is both", async () => {
    (
      payrollReportService.sendReportEmailWithAttachments as jest.Mock
    ).mockResolvedValue(true);

    const result = await generateAndSendReport(
      "emp-1",
      "test@example.com",
      "monthly",
      ["summary"],
      "both",
    );

    expect(result.sent).toBe(true);
    expect(pdfGeneratorService.generatePayrollReport).toHaveBeenCalled();
    expect(payrollReportService.generatePayrollReportCsv).toHaveBeenCalled();
    expect(
      payrollReportService.sendReportEmailWithAttachments,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        pdfBuffer: expect.any(Buffer),
        csvBuffer: expect.any(Buffer),
      }),
    );
  });

  it("returns sent=false when all retries fail", async () => {
    (
      payrollReportService.sendReportEmailWithAttachments as jest.Mock
    ).mockRejectedValue(new Error("SMTP error"));

    const result = await generateAndSendReport(
      "emp-1",
      "test@example.com",
      "weekly",
      ["summary"],
      "pdf",
    );

    expect(result.sent).toBe(false);
    expect(
      payrollReportService.sendReportEmailWithAttachments,
    ).toHaveBeenCalledTimes(3);
    expect(payrollReportScheduleDb.recordGeneratedReport).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "failed",
      }),
    );
  });

  it("skips PDF generation when format is csv", async () => {
    (
      payrollReportService.sendReportEmailWithAttachments as jest.Mock
    ).mockResolvedValue(true);

    await generateAndSendReport(
      "emp-1",
      "test@example.com",
      "monthly",
      ["summary"],
      "csv",
    );

    expect(pdfGeneratorService.generatePayrollReport).not.toHaveBeenCalled();
    expect(payrollReportService.generatePayrollReportCsv).toHaveBeenCalled();
    expect(
      payrollReportService.sendReportEmailWithAttachments,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        pdfBuffer: null,
        csvBuffer: expect.any(Buffer),
      }),
    );
  });

  it("continues when IPFS pinning fails", async () => {
    (ipfsService.pinProofToIPFS as jest.Mock).mockRejectedValue(
      new Error("IPFS down"),
    );
    (
      payrollReportService.sendReportEmailWithAttachments as jest.Mock
    ).mockResolvedValue(true);

    const result = await generateAndSendReport(
      "emp-1",
      "test@example.com",
      "monthly",
      ["summary"],
      "pdf",
    );

    expect(result.sent).toBe(true);
    expect(result.ipfsUrl).toBeUndefined();
  });

  it("uses fallback branding when branding service fails", async () => {
    (brandingService.getBrandingForEmployer as jest.Mock).mockRejectedValue(
      new Error("not found"),
    );
    (
      payrollReportService.sendReportEmailWithAttachments as jest.Mock
    ).mockResolvedValue(true);

    const result = await generateAndSendReport(
      "emp-1",
      "test@example.com",
      "monthly",
      ["summary"],
      "pdf",
    );

    expect(result.sent).toBe(true);
    expect(pdfGeneratorService.generatePayrollReport).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ primaryColor: "#2563eb" }),
      expect.any(String),
      expect.any(Array),
    );
  });
});

describe("calculateNextSendDate", () => {
  it("calculates next weekly date", () => {
    const base = new Date(2026, 0, 1, 10, 0, 0); // Thursday Jan 1 2026
    const next = calculateNextSendDate("weekly", null, 1, base); // Next Monday
    expect(next.getDay()).toBe(1);
    expect(next > base).toBe(true);
  });

  it("calculates next monthly date", () => {
    const base = new Date(2026, 0, 15); // Jan 15 2026
    const next = calculateNextSendDate("monthly", 1, null, base); // Feb 1 2026
    expect(next.getMonth()).toBe(1);
    expect(next.getDate()).toBe(1);
  });

  it("calculates next quarterly date", () => {
    const base = new Date(2026, 0, 15); // Jan 15 2026
    const next = calculateNextSendDate("quarterly", 5, null, base); // Apr 5 2026
    expect(next.getMonth()).toBe(3);
    expect(next.getDate()).toBe(5);
  });
});

describe("processScheduledReports", () => {
  it("processes each due schedule and updates lastSentAt", async () => {
    (
      payrollReportScheduleDb.getEnabledSchedulesDue as jest.Mock
    ).mockResolvedValue([
      {
        id: 1,
        employerId: "emp-1",
        email: "a@b.com",
        frequency: "monthly",
        includeSections: ["summary"],
        format: "pdf",
      },
      {
        id: 2,
        employerId: "emp-2",
        email: "c@d.com",
        frequency: "weekly",
        includeSections: ["summary"],
        format: "pdf",
      },
    ]);
    (
      payrollReportService.sendReportEmailWithAttachments as jest.Mock
    ).mockResolvedValue(true);

    await processScheduledReports();

    expect(
      payrollReportScheduleDb.updateReportScheduleLastSent,
    ).toHaveBeenCalledTimes(2);
  });

  it("logs error when report generation fails but continues processing", async () => {
    (
      payrollReportScheduleDb.getEnabledSchedulesDue as jest.Mock
    ).mockResolvedValue([
      { id: 1, employerId: "emp-1", email: "a@b.com", frequency: "monthly" },
      { id: 2, employerId: "emp-2", email: "c@d.com", frequency: "weekly" },
    ]);
    (reportDataService.generateReportData as jest.Mock)
      .mockRejectedValueOnce(new Error("DB error"))
      .mockResolvedValueOnce(mockReportData);
    (
      payrollReportService.sendReportEmailWithAttachments as jest.Mock
    ).mockResolvedValue(true);

    await processScheduledReports();

    expect(serviceLogger.serviceLogger.error).toHaveBeenCalledWith(
      "PayrollReport",
      expect.stringContaining("Failed to generate report"),
      expect.any(Error),
      expect.objectContaining({ scheduleId: 1 }),
    );
    expect(
      payrollReportScheduleDb.updateReportScheduleLastSent,
    ).toHaveBeenCalledTimes(1);
  });

  it("handles empty schedule list gracefully", async () => {
    (
      payrollReportScheduleDb.getEnabledSchedulesDue as jest.Mock
    ).mockResolvedValue([]);

    await processScheduledReports();

    expect(
      payrollReportScheduleDb.updateReportScheduleLastSent,
    ).not.toHaveBeenCalled();
  });
});

