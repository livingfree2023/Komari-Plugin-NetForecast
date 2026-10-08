import { BillingCycle, NodeCoreConfig, NodeForecastData, ThresholdMode, TrafficRecord } from "./types";

export function getDaysInMonth(year: number, month: number): number {
  return new Date(year, month + 1, 0).getDate();
}

/**
 * 从 Komari 节点的 expired_at 字段中提取每月的账单重置日 (Day of Month: 1 - 31)
 */
export function extractResetDayFromExpiredAt(
  expiredAt?: string | number | null,
  fallbackResetDay: number = 1
): {
  resetDay: number;
  hasExpiredAt: boolean;
  expiredAtStr?: string;
  desc: string;
} {
  if (!expiredAt) {
    return {
      resetDay: Math.max(1, Math.min(31, fallbackResetDay || 1)),
      hasExpiredAt: false,
      desc: "自然月 1 号 (未设置到期日)",
    };
  }

  try {
    let dateObj: Date;
    if (typeof expiredAt === "number") {
      dateObj = expiredAt > 10000000000 ? new Date(expiredAt) : new Date(expiredAt * 1000);
    } else {
      dateObj = new Date(String(expiredAt));
    }

    if (isNaN(dateObj.getTime())) {
      return {
        resetDay: fallbackResetDay || 1,
        hasExpiredAt: false,
        desc: "自然月 1 号 (到期时间格式无效)",
      };
    }

    const day = dateObj.getDate();
    const dateStr = dateObj.toISOString().split("T")[0];

    return {
      resetDay: Math.max(1, Math.min(31, day)),
      hasExpiredAt: true,
      expiredAtStr: dateStr,
      desc: `每月 ${day} 号 (同步自节点到期日: ${dateStr})`,
    };
  } catch (e) {
    return {
      resetDay: fallbackResetDay || 1,
      hasExpiredAt: false,
      desc: "自然月 1 号",
    };
  }
}

/**
 * 根据计费模式计算计费流量数值
 */
export function computeBillableAmount(inBytes: number, outBytes: number, mode: string = "sum"): number {
  const m = (mode || "sum").toLowerCase();
  switch (m) {
    case "upload":
    case "up":
      return outBytes;
    case "download":
    case "down":
      return inBytes;
    case "max":
      return Math.max(inBytes, outBytes);
    case "min":
      return Math.min(inBytes, outBytes);
    case "sum":
    default:
      return inBytes + outBytes;
  }
}

/**
 * 计算账单周期范围
 * @param resetDay 每月重置日 (1-31)
 * @param now 当前时间
 */
export function calculateBillingCycle(resetDay: number = 1, now: Date = new Date()): BillingCycle {
  const currentYear = now.getFullYear();
  const currentMonth = now.getMonth();
  const currentDate = now.getDate();

  const safeResetDay = Math.max(1, Math.min(31, Math.floor(resetDay || 1)));

  let cycleStartDate: Date;
  let cycleEndDate: Date;

  if (currentDate >= safeResetDay) {
    const maxDayThisMonth = getDaysInMonth(currentYear, currentMonth);
    const actualStartDay = Math.min(safeResetDay, maxDayThisMonth);
    cycleStartDate = new Date(currentYear, currentMonth, actualStartDay, 0, 0, 0, 0);

    const nextMonthYear = currentMonth === 11 ? currentYear + 1 : currentYear;
    const nextMonth = currentMonth === 11 ? 0 : currentMonth + 1;
    const maxDayNextMonth = getDaysInMonth(nextMonthYear, nextMonth);
    const actualEndDay = Math.min(safeResetDay, maxDayNextMonth);
    cycleEndDate = new Date(nextMonthYear, nextMonth, actualEndDay, 0, 0, 0, 0);
  } else {
    const prevMonthYear = currentMonth === 0 ? currentYear - 1 : currentYear;
    const prevMonth = currentMonth === 0 ? 11 : currentMonth - 1;
    const maxDayPrevMonth = getDaysInMonth(prevMonthYear, prevMonth);
    const actualStartDay = Math.min(safeResetDay, maxDayPrevMonth);
    cycleStartDate = new Date(prevMonthYear, prevMonth, actualStartDay, 0, 0, 0, 0);

    const maxDayThisMonth = getDaysInMonth(currentYear, currentMonth);
    const actualEndDay = Math.min(safeResetDay, maxDayThisMonth);
    cycleEndDate = new Date(currentYear, currentMonth, actualEndDay, 0, 0, 0, 0);
  }

  const oneDayMs = 24 * 60 * 60 * 1000;
  const daysTotal = Math.max(1, Math.round((cycleEndDate.getTime() - cycleStartDate.getTime()) / oneDayMs));
  const daysElapsed = Math.max(1, Math.min(daysTotal, Math.ceil((now.getTime() - cycleStartDate.getTime()) / oneDayMs)));
  const daysRemaining = Math.max(0, daysTotal - daysElapsed);

  return {
    cycleStart: cycleStartDate.toISOString().split("T")[0],
    cycleEnd: cycleEndDate.toISOString().split("T")[0],
    cycleStartDate,
    cycleEndDate,
    daysTotal,
    daysElapsed,
    daysRemaining,
  };
}

/**
 * 格式化字节大小为可读字符串
 */
export function formatBytes(bytes: number, decimals: number = 2): string {
  if (!bytes || bytes === 0) return "0 B";
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ["B", "KB", "MB", "GB", "TB", "PB"];
  const i = Math.floor(Math.log(Math.abs(bytes)) / Math.log(k));
  const idx = Math.min(i, sizes.length - 1);
  return parseFloat((bytes / Math.pow(k, idx)).toFixed(dm)) + " " + sizes[idx];
}

/**
 * 计费模式简要名称映射
 */
export function getThresholdModeLabel(mode: string = "sum"): string {
  const m = (mode || "sum").toLowerCase();
  switch (m) {
    case "upload":
    case "up":
      return "仅出站 (Upload)";
    case "download":
    case "down":
      return "仅入站 (Download)";
    case "max":
      return "双向取大 (MAX)";
    case "min":
      return "双向取小 (MIN)";
    case "sum":
    default:
      return "双向求和 (SUM)";
  }
}

/**
 * 计算单个节点的流量预测与预警信息
 */
export function calculateNodeForecast(
  history: TrafficRecord[],
  node: NodeCoreConfig,
  warningThresholdPercent: number = 90,
  now: Date = new Date()
): NodeForecastData {
  // 从核心节点的 expired_at 提取账单重置日（若未设置则按自然月 1 号）
  const extracted = extractResetDayFromExpiredAt(node.expired_at, Number(node.traffic_reset_day) || 1);
  const resetDay = extracted.resetDay;
  const cycle = calculateBillingCycle(resetDay, now);
  const cycleStartMs = cycle.cycleStartDate.getTime();

  const mode = (node.traffic_limit_type || "sum") as ThresholdMode;

  // 1. 本周期内流量累计
  let cumulativeIn = 0;
  let cumulativeOut = 0;

  for (const r of history) {
    if (r.timestamp >= cycleStartMs && r.timestamp <= now.getTime()) {
      cumulativeIn += r.in_bytes || 0;
      cumulativeOut += r.out_bytes || 0;
    }
  }

  const cumulativePhysicalTotal = cumulativeIn + cumulativeOut;
  const cumulativeBillable = computeBillableAmount(cumulativeIn, cumulativeOut, mode);

  // 2. 近7天加权移动平均日均增量
  const recentDays = history.slice(-7);
  let dailyAvgIn = 0;
  let dailyAvgOut = 0;

  if (recentDays.length > 0) {
    let weightSum = 0;
    let weightedInSum = 0;
    let weightedOutSum = 0;

    recentDays.forEach((record, index) => {
      const weight = 1 + (index / recentDays.length) * 1.2;
      weightedInSum += (record.in_bytes || 0) * weight;
      weightedOutSum += (record.out_bytes || 0) * weight;
      weightSum += weight;
    });

    dailyAvgIn = Math.round(weightedInSum / weightSum);
    dailyAvgOut = Math.round(weightedOutSum / weightSum);
  } else if (cycle.daysElapsed > 0) {
    dailyAvgIn = Math.round(cumulativeIn / cycle.daysElapsed);
    dailyAvgOut = Math.round(cumulativeOut / cycle.daysElapsed);
  }

  const dailyAvgTotal = dailyAvgIn + dailyAvgOut;
  const dailyAvgBillable = computeBillableAmount(dailyAvgIn, dailyAvgOut, mode);

  // 3. 周期末预测到达量
  const projectedIn = cumulativeIn + dailyAvgIn * cycle.daysRemaining;
  const projectedOut = cumulativeOut + dailyAvgOut * cycle.daysRemaining;
  const projectedPhysicalTotal = cumulativePhysicalTotal + dailyAvgTotal * cycle.daysRemaining;
  const projectedBillable = computeBillableAmount(projectedIn, projectedOut, mode);

  // 4. 配额与状态评估
  const rawQuota = Number(node.traffic_limit) || 0;
  const hasQuota = rawQuota > 0;

  let status: "SAFE" | "WARNING" | "CRITICAL" | "NO_QUOTA" = "NO_QUOTA";
  let usageRatio = 0;
  let daysUntilExhaustion: number | undefined;
  let exhaustionDate: string | undefined;
  let warningMessage: string | undefined;

  if (!hasQuota) {
    status = "NO_QUOTA";
  } else {
    usageRatio = projectedBillable / rawQuota;
    const modeBadge = getThresholdModeLabel(mode);

    if (cumulativeBillable >= rawQuota) {
      status = "CRITICAL";
      daysUntilExhaustion = 0;
      exhaustionDate = now.toISOString().split("T")[0];
      warningMessage = `已超出流量限额 (${formatBytes(cumulativeBillable)} / ${formatBytes(rawQuota)})，超额 ${formatBytes(cumulativeBillable - rawQuota)}！`;
    } else if (projectedBillable >= rawQuota) {
      status = "CRITICAL";
      const remainingQuota = rawQuota - cumulativeBillable;
      daysUntilExhaustion = dailyAvgBillable > 0 ? Math.max(1, Math.floor(remainingQuota / dailyAvgBillable)) : 999;
      const exDateObj = new Date(now.getTime() + daysUntilExhaustion * 24 * 60 * 60 * 1000);
      exhaustionDate = exDateObj.toISOString().split("T")[0];
      const overage = projectedBillable - rawQuota;
      warningMessage = `预计将在 ${daysUntilExhaustion} 天后（${exhaustionDate}）耗尽限额（按 ${modeBadge} 计费），重置日前预计超标 ${formatBytes(overage)}！`;
    } else if (usageRatio >= warningThresholdPercent / 100) {
      status = "WARNING";
      warningMessage = `预计在重置日将消耗 ${(usageRatio * 100).toFixed(1)}% 的计费流量，接近告警阈值 (${warningThresholdPercent}%)。`;
    } else {
      status = "SAFE";
      warningMessage = `流量在安全预算内，预计重置日使用率为 ${(usageRatio * 100).toFixed(1)}%，剩余可用计费流量约 ${formatBytes(rawQuota - projectedBillable)}。`;
    }
  }

  // 5. 构建固定 30 天时间序列与预测序列
  const chartSeries = build30DaySeries(history, mode, cycle, dailyAvgIn, dailyAvgOut, now);

  return {
    node_id: node.uuid,
    node_name: node.name || node.uuid,
    tags: node.tags,
    group: node.group,
    has_quota: hasQuota,
    traffic_limit_bytes: rawQuota,
    traffic_limit_formatted: hasQuota ? formatBytes(rawQuota) : "未设置限额",
    traffic_limit_type: mode,
    has_expired_at: extracted.hasExpiredAt,
    expired_at_raw: node.expired_at,
    expired_at_str: extracted.expiredAtStr,
    traffic_reset_day: resetDay,
    reset_day_desc: extracted.desc,
    cycle,
    cumulative: {
      in_bytes: cumulativeIn,
      out_bytes: cumulativeOut,
      physical_total: cumulativePhysicalTotal,
      billable_bytes: cumulativeBillable,
      in_formatted: formatBytes(cumulativeIn),
      out_formatted: formatBytes(cumulativeOut),
      physical_formatted: formatBytes(cumulativePhysicalTotal),
      billable_formatted: formatBytes(cumulativeBillable),
    },
    daily_avg: {
      in_bytes: dailyAvgIn,
      out_bytes: dailyAvgOut,
      total_bytes: dailyAvgTotal,
      billable_bytes: dailyAvgBillable,
      total_formatted: formatBytes(dailyAvgTotal),
      billable_formatted: formatBytes(dailyAvgBillable),
    },
    projected: {
      in_bytes: projectedIn,
      out_bytes: projectedOut,
      physical_total: projectedPhysicalTotal,
      billable_bytes: projectedBillable,
      physical_formatted: formatBytes(projectedPhysicalTotal),
      billable_formatted: formatBytes(projectedBillable),
    },
    usage_ratio: usageRatio,
    status,
    days_until_exhaustion: daysUntilExhaustion,
    exhaustion_date: exhaustionDate,
    warning_message: warningMessage,
    chart_series: chartSeries,
  };
}

/**
 * 构建 30 天时间序列（过去30天堆叠柱 + 计费模式对应的累计曲线 + 未来外推虚线）
 */
export function build30DaySeries(
  history: TrafficRecord[],
  mode: ThresholdMode,
  cycle: BillingCycle,
  dailyAvgIn: number,
  dailyAvgOut: number,
  now: Date = new Date()
): TrafficRecord[] {
  const display = (history || []).slice(-30);
  const cycleStartMs = cycle.cycleStartDate.getTime();

  let runningIn = 0;
  let runningOut = 0;

  const points: TrafficRecord[] = display.map((item) => {
    if (item.timestamp >= cycleStartMs) {
      runningIn += item.in_bytes || 0;
      runningOut += item.out_bytes || 0;
    }
    const cumBillable = computeBillableAmount(runningIn, runningOut, mode);

    return {
      date: item.date,
      timestamp: item.timestamp,
      in_bytes: item.in_bytes,
      out_bytes: item.out_bytes,
      total_bytes: item.total_bytes,
      cumulative_bytes: runningIn + runningOut,
      cumulative_billable: cumBillable,
      is_forecast: false,
    };
  });

  if (cycle.daysRemaining > 0) {
    let fIn = runningIn;
    let fOut = runningOut;
    const maxForecastDays = Math.min(cycle.daysRemaining, 14);

    for (let i = 1; i <= maxForecastDays; i++) {
      const fd = new Date(now.getTime() + i * 24 * 3600 * 1000);
      fIn += dailyAvgIn;
      fOut += dailyAvgOut;
      const cumBillable = computeBillableAmount(fIn, fOut, mode);

      points.push({
        date: fd.toISOString().split("T")[0],
        timestamp: fd.getTime(),
        in_bytes: dailyAvgIn,
        out_bytes: dailyAvgOut,
        total_bytes: dailyAvgIn + dailyAvgOut,
        cumulative_bytes: fIn + fOut,
        cumulative_billable: cumBillable,
        is_forecast: true,
      });
    }
  }

  return points;
}
