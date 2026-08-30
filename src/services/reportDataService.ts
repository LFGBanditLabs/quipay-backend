import { getDb } from "../db/pool";
import {
  payrollStreams,
  withdrawals,
  vaultEvents,
  employers,
  treasuryBalances,
  streamAuditLog,
} from "../db/schema";
import { eq, and, gte, lte, sql } from "drizzle-orm";

export interface ReportWorkerData {
  workerAddress: string;
  workerName?: string;
  workerEmail?: string;
  totalReceived: string;
  streamCount: number;
  streamId?: number;
  flowRate?: string; // e.g. "0.05 XLM/sec"
}

export interface ReportVaultActivity {
  totalDeposits: string;
  totalDisbursed: string;
  currentBalance: string;
  runwayDays?: number;
  runwayEstimate?: string;
}

export interface ReportStreamEvent {
  eventType: string;
  streamId: number;
  workerAddress: string;
  timestamp: Date;
  details?: string;
}

export interface PayrollReportData {
  employerId: string;
  employerName?: string;
  periodStart: Date;
  periodEnd: Date;
  frequency?: string;
  totalPaid: string;
  activeStreams: number;
  completedStreams: number;
  totalFlowRate?: string;
  workers: ReportWorkerData[];
  vaultActivity: ReportVaultActivity;
  streamEvents: ReportStreamEvent[];
}

/**
 * Helper to format stroops to XLM string
 */
export const formatStroopsToXlm = (stroops: string | number | bigint): string => {
  const num = typeof stroops === "bigint" ? Number(stroops) : parseFloat(String(stroops));
  if (!Number.isFinite(num)) return "0.00";
  return (num / 1e7).toFixed(2);
};

/**
 * Generate payroll report data for an employer over a given period.
 * Queries real stream, withdrawal, and vault data from the database.
 */
export const generateReportData = async (
  employerId: string,
  periodStart: Date,
  periodEnd: Date,
  frequency: string = "monthly",
): Promise<PayrollReportData> => {
  const db = getDb();
  if (!db) {
    return emptyReport(employerId, periodStart, periodEnd, frequency);
  }

  // Convert dates to unix seconds for comparison with bigint timestamps
  const startTs = Math.floor(periodStart.getTime() / 1000);
  const endTs = Math.floor(periodEnd.getTime() / 1000);

  // 0. Employer information
  let employerName: string | undefined;
  try {
    const [emp] = await db
      .select({ businessName: employers.businessName })
      .from(employers)
      .where(eq(employers.employerId, employerId))
      .limit(1);
    if (emp?.businessName) {
      employerName = emp.businessName;
    }
  } catch {
    // Ignore if employers table query fails
  }

  // 1. Stream counts and active streams with flow rates
  const [streamCounts] = await db
    .select({
      active: sql<string>`COUNT(CASE WHEN ${payrollStreams.status} = 'active' THEN 1 END)`,
      completed: sql<string>`COUNT(CASE WHEN ${payrollStreams.status} = 'completed' THEN 1 END)`,
    })
    .from(payrollStreams)
    .where(eq(payrollStreams.employerAddress, employerId));

  // Active streams list to calculate flow rates and worker mapping
  const activeStreamRows = await db
    .select({
      streamId: payrollStreams.streamId,
      workerAddress: payrollStreams.workerAddress,
      totalAmount: payrollStreams.totalAmount,
      rate: payrollStreams.rate,
      startTs: payrollStreams.startTs,
      endTs: payrollStreams.endTs,
      status: payrollStreams.status,
    })
    .from(payrollStreams)
    .where(
      and(
        eq(payrollStreams.employerAddress, employerId),
        eq(payrollStreams.status, "active"),
      ),
    );

  // Calculate flow rate per active stream
  const workerFlowRateMap = new Map<string, { streamId: number; flowRateStroopsPerSec: number }>();
  let totalFlowRateStroopsPerSec = 0;

  for (const stream of activeStreamRows) {
    let ratePerSec = 0;
    if (stream.rate) {
      ratePerSec = parseFloat(stream.rate);
    } else {
      const duration = Number(stream.endTs) - Number(stream.startTs);
      if (duration > 0) {
        ratePerSec = parseFloat(stream.totalAmount) / duration;
      }
    }
    totalFlowRateStroopsPerSec += ratePerSec;
    workerFlowRateMap.set(stream.workerAddress, {
      streamId: stream.streamId,
      flowRateStroopsPerSec: ratePerSec,
    });
  }

  // 2. Worker breakdown — withdrawals in period grouped by worker
  const workerRows = await db
    .select({
      workerAddress: withdrawals.worker,
      totalReceived: sql<string>`COALESCE(SUM(${withdrawals.amount}), 0)`,
      streamCount: sql<string>`COUNT(DISTINCT ${withdrawals.streamId})`,
      latestStreamId: sql<number>`MAX(${withdrawals.streamId})`,
    })
    .from(withdrawals)
    .innerJoin(
      payrollStreams,
      eq(withdrawals.streamId, payrollStreams.streamId),
    )
    .where(
      and(
        eq(payrollStreams.employerAddress, employerId),
        gte(withdrawals.ledgerTs, startTs),
        lte(withdrawals.ledgerTs, endTs),
      ),
    )
    .groupBy(withdrawals.worker);

  // Combine worker breakdown with active streams info
  const workers: ReportWorkerData[] = workerRows.map((r) => {
    const activeInfo = workerFlowRateMap.get(r.workerAddress);
    const flowRateStr = activeInfo
      ? `${(activeInfo.flowRateStroopsPerSec / 1e7).toFixed(4)} XLM/sec`
      : undefined;

    return {
      workerAddress: r.workerAddress,
      totalReceived: r.totalReceived,
      streamCount: parseInt(String(r.streamCount), 10),
      streamId: activeInfo?.streamId ?? r.latestStreamId,
      flowRate: flowRateStr,
    };
  });

  // Also include workers who have active streams even if 0 withdrawals occurred in period
  for (const [workerAddr, info] of workerFlowRateMap.entries()) {
    if (!workers.some((w) => w.workerAddress === workerAddr)) {
      workers.push({
        workerAddress: workerAddr,
        totalReceived: "0",
        streamCount: 1,
        streamId: info.streamId,
        flowRate: `${(info.flowRateStroopsPerSec / 1e7).toFixed(4)} XLM/sec`,
      });
    }
  }

  // 3. Total paid in period
  const [totalPaidRow] = await db
    .select({
      total: sql<string>`COALESCE(SUM(${withdrawals.amount}), 0)`,
    })
    .from(withdrawals)
    .innerJoin(
      payrollStreams,
      eq(withdrawals.streamId, payrollStreams.streamId),
    )
    .where(
      and(
        eq(payrollStreams.employerAddress, employerId),
        gte(withdrawals.ledgerTs, startTs),
        lte(withdrawals.ledgerTs, endTs),
      ),
    );

  // 4. Vault activity in period
  const [vaultDeposits] = await db
    .select({ total: sql<string>`COALESCE(SUM(${vaultEvents.amount}), 0)` })
    .from(vaultEvents)
    .where(
      and(
        eq(vaultEvents.address, employerId),
        eq(vaultEvents.eventType, "deposit"),
        gte(vaultEvents.ledgerTs, startTs),
        lte(vaultEvents.ledgerTs, endTs),
      ),
    );

  const [vaultPayouts] = await db
    .select({ total: sql<string>`COALESCE(SUM(${vaultEvents.amount}), 0)` })
    .from(vaultEvents)
    .where(
      and(
        eq(vaultEvents.address, employerId),
        eq(vaultEvents.eventType, "payout"),
        gte(vaultEvents.ledgerTs, startTs),
        lte(vaultEvents.ledgerTs, endTs),
      ),
    );

  // Current balance check from treasuryBalances or net vault events
  let currentBalanceStr = "0";
  try {
    const [treasury] = await db
      .select({ balance: treasuryBalances.balance })
      .from(treasuryBalances)
      .where(eq(treasuryBalances.employer, employerId))
      .limit(1);

    if (treasury?.balance !== undefined && treasury.balance !== null) {
      currentBalanceStr = treasury.balance;
    } else {
      const deposits = BigInt(vaultDeposits?.total ?? "0");
      const payouts = BigInt(vaultPayouts?.total ?? "0");
      currentBalanceStr = (deposits - payouts).toString();
    }
  } catch {
    const deposits = BigInt(vaultDeposits?.total ?? "0");
    const payouts = BigInt(vaultPayouts?.total ?? "0");
    currentBalanceStr = (deposits - payouts).toString();
  }

  // Runway estimation
  let runwayDays: number | undefined;
  let runwayEstimate: string | undefined;
  const currentBalanceStroops = parseFloat(currentBalanceStr);
  const dailyBurnStroops = totalFlowRateStroopsPerSec * 86400;

  if (dailyBurnStroops > 0 && currentBalanceStroops > 0) {
    runwayDays = Math.floor(currentBalanceStroops / dailyBurnStroops);
    if (runwayDays > 60) {
      runwayEstimate = `${(runwayDays / 30).toFixed(1)} months`;
    } else {
      runwayEstimate = `${runwayDays} days`;
    }
  } else if (dailyBurnStroops === 0) {
    runwayEstimate = "N/A (no active burn)";
  } else {
    runwayEstimate = "0 days (fund vault)";
  }

  // 5. Stream events in period (created, paused, cancelled, completed)
  const streamEventRows = await db
    .select({
      eventType: payrollStreams.status,
      streamId: payrollStreams.streamId,
      workerAddress: payrollStreams.workerAddress,
      timestamp: payrollStreams.createdAt,
    })
    .from(payrollStreams)
    .where(
      and(
        eq(payrollStreams.employerAddress, employerId),
        gte(payrollStreams.createdAt, periodStart),
        lte(payrollStreams.createdAt, periodEnd),
      ),
    );

  // Also query streamAuditLog for status transition events if available
  const events: ReportStreamEvent[] = streamEventRows.map((r) => ({
    eventType: r.eventType === "active" ? "Stream Created" : r.eventType,
    streamId: r.streamId,
    workerAddress: r.workerAddress,
    timestamp: r.timestamp,
  }));

  try {
    const auditEvents = await db
      .select({
        action: streamAuditLog.action,
        streamId: streamAuditLog.streamId,
        newStatus: streamAuditLog.newStatus,
        reason: streamAuditLog.reason,
        createdAt: streamAuditLog.createdAt,
      })
      .from(streamAuditLog)
      .innerJoin(payrollStreams, eq(streamAuditLog.streamId, payrollStreams.streamId))
      .where(
        and(
          eq(payrollStreams.employerAddress, employerId),
          gte(streamAuditLog.createdAt, periodStart),
          lte(streamAuditLog.createdAt, periodEnd),
        ),
      );

    for (const ae of auditEvents) {
      events.push({
        eventType: ae.action.toUpperCase(),
        streamId: ae.streamId,
        workerAddress: "",
        timestamp: ae.createdAt,
        details: ae.reason || ae.newStatus || undefined,
      });
    }
  } catch {
    // Ignore if streamAuditLog is not populated
  }

  return {
    employerId,
    employerName,
    periodStart,
    periodEnd,
    frequency,
    totalPaid: totalPaidRow?.total ?? "0",
    activeStreams: parseInt(streamCounts?.active ?? "0", 10),
    completedStreams: parseInt(streamCounts?.completed ?? "0", 10),
    totalFlowRate:
      totalFlowRateStroopsPerSec > 0
        ? `${(totalFlowRateStroopsPerSec / 1e7).toFixed(4)} XLM/sec`
        : undefined,
    workers,
    vaultActivity: {
      totalDeposits: vaultDeposits?.total ?? "0",
      totalDisbursed: vaultPayouts?.total ?? "0",
      currentBalance: currentBalanceStr,
      runwayDays,
      runwayEstimate,
    },
    streamEvents: events,
  };
};

function emptyReport(
  employerId: string,
  periodStart: Date,
  periodEnd: Date,
  frequency: string = "monthly",
): PayrollReportData {
  return {
    employerId,
    periodStart,
    periodEnd,
    frequency,
    totalPaid: "0",
    activeStreams: 0,
    completedStreams: 0,
    workers: [],
    vaultActivity: {
      totalDeposits: "0",
      totalDisbursed: "0",
      currentBalance: "0",
      runwayEstimate: "N/A",
    },
    streamEvents: [],
  };
}
