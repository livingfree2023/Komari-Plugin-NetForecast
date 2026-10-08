import { NodeQuotaConfig, NodeTrafficData, TrafficRecord } from "./types";

export function getDaysInMonth(year: number, month: number): number {
  return new Date(year, month + 1, 0).getDate();
}

/**
 * 计算账单周期范围
 * @param resetDay 每月重置日 (1-31)
 * @param now 当前时间
 */
export function calculateBillingCycle(resetDay: number, now: Date = new Date()) {
  const currentYear = now.getFullYear();
  const currentMonth = now.getMonth();
  const currentDate = now.getDate();

  // 规范化 resetDay，防止超过当月最大天数
  const safeResetDay = Math.max(1, Math.min(31, Math.floor(resetDay || 1)));

  let cycleStartDate: Date;
  let cycleEndDate: Date;

  if (currentDate >= safeResetDay) {
    // 周期开始于当月的 resetDay
    const maxDayThisMonth = getDaysInMonth(currentYear, currentMonth);
    const actualStartDay = Math.min(safeResetDay, maxDayThisMonth);
    cycleStartDate = new Date(currentYear, currentMonth, actualStartDay, 0, 0, 0, 0);

    // 周期结束于下月的 resetDay
    const nextMonthYear = currentMonth === 11 ? currentYear + 1 : currentYear;
    const nextMonth = currentMonth === 11 ? 0 : currentMonth + 1;
    const maxDayNextMonth = getDaysInMonth(nextMonthYear, nextMonth);
    const actualEndDay = Math.min(safeResetDay, maxDayNextMonth);
    cycleEndDate = new Date(nextMonthYear, nextMonth, actualEndDay, 0, 0, 0, 0);
  } else {
    // 周期开始于上月的 resetDay
    const prevMonthYear = currentMonth === 0 ? currentYear - 1 : currentYear;
    const prevMonth = currentMonth === 0 ? 11 : currentMonth - 1;
    const maxDayPrevMonth = getDaysInMonth(prevMonthYear, prevMonth);
    const actualStartDay = Math.min(safeResetDay, maxDayPrevMonth);
    cycleStartDate = new Date(prevMonthYear, prevMonth, actualStartDay, 0, 0, 0, 0);

    // 周期结束于当月的 resetDay
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
  if (bytes === 0) return "0 B";
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ["B", "KB", "MB", "GB", "TB", "PB"];
  const i = Math.floor(Math.log(Math.abs(bytes)) / Math.log(k));
  const idx = Math.min(i, sizes.length - 1);
  return parseFloat((bytes / Math.pow(k, idx)).toFixed(dm)) + " " + sizes[idx];
}

/**
 * 计算当月累计与未来预测
 */
export function calculateForecast(
  history: TrafficRecord[],
  quotaConfig: NodeQuotaConfig,
  warningThresholdPercent: number = 90,
  now: Date = new Date()
) {
  const cycle = calculateBillingCycle(quotaConfig.reset_day, now);
  const cycleStartMs = cycle.cycleStartDate.getTime();
  const cycleEndMs = cycle.cycleEndDate.getTime();

  // 1. 过滤并计算当月周期内的累计流量
  const cycleRecords = history.filter((r) => r.timestamp >= cycleStartMs && r.timestamp < cycleEndMs);

  let cumulativeIn = 0;
  let cumulativeOut = 0;

  for (const r of cycleRecords) {
    cumulativeIn += r.in_bytes || 0;
    cumulativeOut += r.out_bytes || 0;
  }
  const cumulativeTotal = cumulativeIn + cumulativeOut;

  // 2. 计算近期日均增量（加权移动平均，优先参考近7天）
  const recentDays = history.slice(-7);
  let dailyAvgIn = 0;
  let dailyAvgOut = 0;

  if (recentDays.length > 0) {
    let weightSum = 0;
    let weightedInSum = 0;
    let weightedOutSum = 0;

    recentDays.forEach((record, index) => {
      // 越近期权重越高 (1.0 -> 2.2)
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

  // 3. 预测到达重置日时的增量与总量
  const projectedRemainIn = dailyAvgIn * cycle.daysRemaining;
  const projectedRemainOut = dailyAvgOut * cycle.daysRemaining;

  const projectedIn = cumulativeIn + projectedRemainIn;
  const projectedOut = cumulativeOut + projectedRemainOut;
  const projectedTotal = cumulativeTotal + (dailyAvgTotal * cycle.daysRemaining);

  // 4. 配额与超限预警状态计算
  const quota = quotaConfig.quota_bytes || 0;
  let usageRatioCurrent = 0;
  let usageRatioProjected = 0;
  let status: "SAFE" | "WARNING" | "CRITICAL" = "SAFE";
  let daysUntilExhaustion: number | undefined;
  let exhaustionDate: string | undefined;
  let warningMessage: string | undefined;

  if (quota > 0) {
    usageRatioCurrent = cumulativeTotal / quota;
    usageRatioProjected = projectedTotal / quota;

    if (cumulativeTotal >= quota) {
      status = "CRITICAL";
      daysUntilExhaustion = 0;
      exhaustionDate = now.toISOString().split("T")[0];
      warningMessage = `已超出流量限额 (${formatBytes(cumulativeTotal)} / ${formatBytes(quota)})，已超标 ${formatBytes(cumulativeTotal - quota)}！`;
    } else if (usageRatioProjected >= 1.0) {
      status = "CRITICAL";
      const remainingQuota = quota - cumulativeTotal;
      daysUntilExhaustion = dailyAvgTotal > 0 ? Math.max(1, Math.floor(remainingQuota / dailyAvgTotal)) : 999;
      
      const exhaustTime = new Date(now.getTime() + daysUntilExhaustion * 24 * 60 * 60 * 1000);
      exhaustionDate = exhaustTime.toISOString().split("T")[0];
      
      const overage = projectedTotal - quota;
      warningMessage = `⚠️ 预警：预计将在 ${daysUntilExhaustion} 天后（${exhaustionDate}）耗尽流量限额，重置日前预计超标 ${formatBytes(overage)}！`;
    } else if (usageRatioProjected >= warningThresholdPercent / 100) {
      status = "WARNING";
      warningMessage = `⚡ 注意：预计在重置日将消耗 ${(usageRatioProjected * 100).toFixed(1)}% 的流量，接近设定阈值 (${warningThresholdPercent}%)。`;
    } else {
      status = "SAFE";
    }
  }

  return {
    cycle,
    cumulative: {
      in_bytes: cumulativeIn,
      out_bytes: cumulativeOut,
      total_bytes: cumulativeTotal,
    },
    daily_avg: {
      in_bytes: dailyAvgIn,
      out_bytes: dailyAvgOut,
      total_bytes: dailyAvgTotal,
    },
    projected: {
      in_bytes: projectedIn,
      out_bytes: projectedOut,
      total_bytes: projectedTotal,
    },
    quota,
    usage_ratio_current: usageRatioCurrent,
    usage_ratio_projected: usageRatioProjected,
    status,
    days_until_exhaustion: daysUntilExhaustion,
    exhaustion_date: exhaustionDate,
    warning_message: warningMessage,
  };
}

/**
 * 为图表生成包含未来预测的扩展时间序列
 */
export function buildChartSeries(
  history: TrafficRecord[],
  range: "1d" | "7d" | "30d",
  forecastData: ReturnType<typeof calculateForecast>
) {
  let displayHistory: TrafficRecord[] = [];
  const now = new Date();

  if (range === "1d") {
    // 最近 1 天（按最近 24 小时或当天切片）
    displayHistory = history.slice(-24);
  } else if (range === "7d") {
    displayHistory = history.slice(-7);
  } else {
    displayHistory = history.slice(-30);
  }

  // 计算每一点的当月累计折线（Cumulative Line）
  let runningCumulative = 0;
  const cycleStartMs = forecastData.cycle.cycleStartDate.getTime();

  const chartPoints = displayHistory.map((item) => {
    if (item.timestamp >= cycleStartMs) {
      runningCumulative += item.total_bytes;
    }
    return {
      ...item,
      cumulative_bytes: runningCumulative,
      is_forecast: false,
    };
  });

  // 生成到重置日的未来预测虚线点（仅当剩余天数 > 0 且在 7d / 30d 模式下叠加）
  const forecastPoints: TrafficRecord[] = [];
  if (range !== "1d" && forecastData.cycle.daysRemaining > 0) {
    const dailyForecastIn = forecastData.daily_avg.in_bytes;
    const dailyForecastOut = forecastData.daily_avg.out_bytes;
    const dailyForecastTotal = forecastData.daily_avg.total_bytes;
    let forecastCum = runningCumulative;

    const maxForecastDays = Math.min(forecastData.cycle.daysRemaining, 14); // 最多预测展现接下来两周
    for (let i = 1; i <= maxForecastDays; i++) {
      const fDate = new Date(now.getTime() + i * 24 * 60 * 60 * 1000);
      const dateStr = fDate.toISOString().split("T")[0];
      forecastCum += dailyForecastTotal;

      forecastPoints.push({
        date: dateStr,
        timestamp: fDate.getTime(),
        in_bytes: dailyForecastIn,
        out_bytes: dailyForecastOut,
        total_bytes: dailyForecastTotal,
        cumulative_bytes: forecastCum,
        is_forecast: true,
      });
    }
  }

  return {
    actual: chartPoints,
    forecast: forecastPoints,
    all: [...chartPoints, ...forecastPoints],
  };
}
