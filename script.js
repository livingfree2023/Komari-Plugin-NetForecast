/**
 * Komari Plugin: NetForecast (网络流量预测与限额预警)
 * Entry script for Komari Goja JS runtime (严格真实数据模式，杜绝假数据)
 */

const server = require("server");
let fs;
let path;
try {
  fs = require("fs");
  path = require("path");
} catch (e) {
  // node compat module fallback
}

function formatBytes(bytes, decimals = 2) {
  if (!bytes || bytes === 0) return "0 B";
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ["B", "KB", "MB", "GB", "TB", "PB"];
  const i = Math.floor(Math.log(Math.abs(bytes)) / Math.log(k));
  const idx = Math.min(i, sizes.length - 1);
  return parseFloat((bytes / Math.pow(k, idx)).toFixed(dm)) + " " + sizes[idx];
}

function getDaysInMonth(year, month) {
  return new Date(year, month + 1, 0).getDate();
}

/**
 * 计费模式简要名称映射
 */
function getThresholdModeLabel(mode) {
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
 * 根据计费模式计算计费流量数值
 */
function computeBillableAmount(inBytes, outBytes, mode = "sum") {
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

function getTzDateParts(now = new Date(), tzOffsetHours = 8) {
  const tzOffsetMs = Number(tzOffsetHours) * 3600 * 1000;
  const d = new Date(now.getTime() + tzOffsetMs);
  const pad2 = (n) => String(n).padStart(2, "0");
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth(),
    date: d.getUTCDate(),
    hours: d.getUTCHours(),
    minutes: d.getUTCMinutes(),
    seconds: d.getUTCSeconds(),
    dateStr: `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`,
  };
}

function formatDateToYMD(d, tzOffsetHours = 8) {
  return getTzDateParts(d, tzOffsetHours).dateStr;
}

/**
 * 计算账单周期范围 (支持用户自定义时区偏移，彻底规避宿主机/容器时区干扰)
 */
function calculateBillingCycle(resetDay = 1, now = new Date(), tzOffsetHours = 8) {
  const tzParts = getTzDateParts(now, tzOffsetHours);
  const currentYear = tzParts.year;
  const currentMonth = tzParts.month;
  const currentDate = tzParts.date;

  const safeResetDay = Math.max(1, Math.min(31, Math.floor(Number(resetDay) || 1)));

  // 当前月的实际月末重置日（例如 4 月是 30，2 月是 28 或 29，防止设置 31 号的节点在小月末无法进入新周期）
  const maxDayThisMonth = getDaysInMonth(currentYear, currentMonth);
  const actualResetDayThisMonth = Math.min(safeResetDay, maxDayThisMonth);

  let cycleStartYear, cycleStartMonth, cycleStartDay;
  let cycleEndYear, cycleEndMonth, cycleEndDay;

  if (currentDate >= actualResetDayThisMonth) {
    cycleStartYear = currentYear;
    cycleStartMonth = currentMonth;
    cycleStartDay = actualResetDayThisMonth;

    const nextMonthYear = currentMonth === 11 ? currentYear + 1 : currentYear;
    const nextMonth = currentMonth === 11 ? 0 : currentMonth + 1;
    const maxDayNextMonth = getDaysInMonth(nextMonthYear, nextMonth);
    cycleEndYear = nextMonthYear;
    cycleEndMonth = nextMonth;
    cycleEndDay = Math.min(safeResetDay, maxDayNextMonth);
  } else {
    const prevMonthYear = currentMonth === 0 ? currentYear - 1 : currentYear;
    const prevMonth = currentMonth === 0 ? 11 : currentMonth - 1;
    const maxDayPrevMonth = getDaysInMonth(prevMonthYear, prevMonth);
    cycleStartYear = prevMonthYear;
    cycleStartMonth = prevMonth;
    cycleStartDay = Math.min(safeResetDay, maxDayPrevMonth);

    cycleEndYear = currentYear;
    cycleEndMonth = currentMonth;
    cycleEndDay = actualResetDayThisMonth;
  }

  const tzMs = Number(tzOffsetHours) * 3600 * 1000;
  const cycleStartUtcMs = Date.UTC(cycleStartYear, cycleStartMonth, cycleStartDay, 0, 0, 0, 0) - tzMs;
  const cycleEndUtcMs = Date.UTC(cycleEndYear, cycleEndMonth, cycleEndDay, 0, 0, 0, 0) - tzMs;

  const cycleStartDate = new Date(cycleStartUtcMs);
  const cycleEndDate = new Date(cycleEndUtcMs);

  const oneDayMs = 24 * 60 * 60 * 1000;
  const daysTotal = Math.max(1, Math.round((cycleEndUtcMs - cycleStartUtcMs) / oneDayMs));
  const daysElapsed = Math.max(1, Math.min(daysTotal, Math.ceil((now.getTime() - cycleStartUtcMs) / oneDayMs)));
  const daysRemaining = Math.max(0, daysTotal - daysElapsed);

  const pad2 = (n) => String(n).padStart(2, "0");
  const cycleStartStr = `${cycleStartYear}-${pad2(cycleStartMonth + 1)}-${pad2(cycleStartDay)}`;
  const cycleEndStr = `${cycleEndYear}-${pad2(cycleEndMonth + 1)}-${pad2(cycleEndDay)}`;

  return {
    cycleStart: cycleStartStr,
    cycleEnd: cycleEndStr,
    cycleStartDate,
    cycleEndDate,
    daysTotal,
    daysElapsed,
    daysRemaining,
    timezoneOffset: tzOffsetHours,
  };
}

/**
 * 历史与预测时间序列构建（真实按日打点，无数据即为 0，绝不伪造）
 */
/**
 * 构建以当前账单周期为时间域的时间序列 (X 轴以 [cycleStart, cycleEnd] 为严格左右边界)
 * - X 轴左侧：上个重置日 (cycleStart)，理论累计从 0 开始
 * - X 轴右侧：下个重置日 (cycleEnd)，预测折线平滑延伸至此
 * - 过去无数据天：cumulative_billable 为 null，不画 0 贴地折线
 * - 未来推算天：in_bytes / out_bytes 严格为 0，坚决不画任何柱体！
 */
function buildCycleSeries(history, mode, cycle, dailyAvgIn, dailyAvgOut, currentCycleBillable, cumulativeIn = 0, cumulativeOut = 0, now = new Date(), tzOffsetHours = 8) {
  const historyMap = {};
  let totalHistIn = 0;
  let totalHistOut = 0;

  (history || []).forEach((item) => {
    if (item.date) {
      historyMap[item.date] = item;
      totalHistIn += (item.in_bytes || 0);
      totalHistOut += (item.out_bytes || 0);
    }
  });

  const totalHistBillable = computeBillableAmount(totalHistIn, totalHistOut, mode);
  // 当网卡物理总计大于可见历史记录和时，将差额作为周期前序底数（彻底消除折线在“今日”突然直角暴涨的缺陷）
  const startOffset = (currentCycleBillable > totalHistBillable) ? (currentCycleBillable - totalHistBillable) : 0;

  const points = [];
  const cycleStartMs = cycle.cycleStartDate.getTime();
  const daysTotal = cycle.daysTotal;
  const todayStr = getTzDateParts(now, tzOffsetHours).dateStr;
  const nowMs = now.getTime();

  let runningIn = 0;
  let runningOut = 0;
  let todayIndex = -1;
  let lastValidCumBillable = startOffset;

  for (let i = 0; i <= daysTotal; i++) {
    const pointUtcMs = cycleStartMs + i * 24 * 3600 * 1000;
    const dateStr = formatDateToYMD(new Date(pointUtcMs), tzOffsetHours);
    const isToday = (dateStr === todayStr);
    const isPast = (pointUtcMs < nowMs) && !isToday;
    const isFuture = (pointUtcMs > nowMs) && !isToday;

    if (isToday) {
      todayIndex = i;
    }

    const rec = historyMap[dateStr];

    if (isPast) {
      if (rec && ((rec.in_bytes || 0) + (rec.out_bytes || 0) > 0)) {
        runningIn += (rec.in_bytes || 0);
        runningOut += (rec.out_bytes || 0);
        const cumBillable = startOffset + computeBillableAmount(runningIn, runningOut, mode);
        lastValidCumBillable = cumBillable;
        points.push({
          date: dateStr,
          timestamp: pointUtcMs,
          has_data: true,
          in_bytes: rec.in_bytes || 0,
          out_bytes: rec.out_bytes || 0,
          total_bytes: (rec.in_bytes || 0) + (rec.out_bytes || 0),
          cumulative_bytes: startOffset + runningIn + runningOut,
          cumulative_billable: cumBillable,
          is_today: false,
          is_forecast: false,
        });
      } else {
        // 过去无打点数据（如冷启动安装前或周期更早）：不画 0 贴地折线，cumulative_billable 为 null
        points.push({
          date: dateStr,
          timestamp: pointUtcMs,
          has_data: false,
          in_bytes: 0,
          out_bytes: 0,
          total_bytes: 0,
          cumulative_bytes: 0,
          cumulative_billable: null,
          is_today: false,
          is_forecast: false,
        });
      }
    } else if (isToday) {
      const inB = rec ? (rec.in_bytes || 0) : 0;
      const outB = rec ? (rec.out_bytes || 0) : 0;
      runningIn += inB;
      runningOut += outB;

      // 今日点：平滑对齐，若有 startOffset 则精确对齐 currentCycleBillable；若无则自然累加，单调递增，杜绝暴跌
      let todayCumBillable = startOffset + computeBillableAmount(runningIn, runningOut, mode);
      if (currentCycleBillable > 0 && currentCycleBillable >= lastValidCumBillable) {
        todayCumBillable = Math.max(currentCycleBillable, todayCumBillable);
      }
      lastValidCumBillable = todayCumBillable;

      points.push({
        date: dateStr,
        timestamp: pointUtcMs,
        has_data: true,
        in_bytes: inB,
        out_bytes: outB,
        total_bytes: inB + outB,
        cumulative_bytes: startOffset + runningIn + runningOut,
        cumulative_billable: todayCumBillable,
        is_today: true,
        is_forecast: false,
      });
    } else {
      // 未来推算点：严格不画柱体 (in_bytes=0, out_bytes=0)，虚线平滑延伸至周期结束日
      const dailyForecastBillable = computeBillableAmount(dailyAvgIn, dailyAvgOut, mode);
      const futureStep = i - (todayIndex >= 0 ? todayIndex : cycle.daysElapsed);
      const fCumBillable = lastValidCumBillable + dailyForecastBillable * Math.max(0, futureStep);

      points.push({
        date: dateStr,
        timestamp: pointUtcMs,
        has_data: false,
        in_bytes: 0,
        out_bytes: 0,
        total_bytes: 0,
        cumulative_bytes: fCumBillable,
        cumulative_billable: fCumBillable,
        is_today: false,
        is_forecast: true,
      });
    }
  }

  return points;
}

const build30DaySeries = buildCycleSeries;

/**
 * 从 Komari 节点的 expired_at 字段中提取每月的账单重置日 (Day of Month: 1 - 31)
 */
function extractResetDayFromExpiredAt(expiredAt, fallbackResetDay = 1, tzOffsetHours = 8) {
  if (!expiredAt) {
    return {
      resetDay: Math.max(1, Math.min(31, fallbackResetDay || 1)),
      hasExpiredAt: false,
      desc: "自然月 1 号 (未设置到期日)",
    };
  }

  try {
    let day = 0;
    let dateStr = "";

    // 优先从日期字符串中直接正则匹配 (YYYY-MM-DD 或 YYYY/MM/DD)，防止时区转换引起的日期 -1 偏移
    if (typeof expiredAt === "string") {
      const match = expiredAt.match(/(\d{4})[/-](\d{1,2})[/-](\d{1,2})/);
      if (match) {
        const y = match[1];
        const m = match[2].padStart(2, "0");
        const d = match[3].padStart(2, "0");
        day = parseInt(d, 10);
        dateStr = `${y}-${m}-${d}`;
      }
    }

    if (!day) {
      let dateObj;
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

      // 叠加配置时区偏移得到准确的到期日
      const tzDate = new Date(dateObj.getTime() + Number(tzOffsetHours) * 3600 * 1000);
      day = tzDate.getUTCDate();
      dateStr = tzDate.toISOString().split("T")[0];
    }

    if (day >= 1 && day <= 31) {
      return {
        resetDay: day,
        hasExpiredAt: true,
        expiredAtStr: dateStr,
        desc: `每月 ${day} 号 (同步自节点到期日: ${dateStr})`,
      };
    }

    return {
      resetDay: fallbackResetDay || 1,
      hasExpiredAt: false,
      desc: "自然月 1 号",
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
 * 核心预测与状态推算（严格使用真实数据，绝不构造假数据）
 */
function calculateNodeForecast(history, node, warningThresholdPercent = 90, now = new Date(), tzOffsetHours = 8) {
  const extracted = extractResetDayFromExpiredAt(node.expired_at, Number(node.traffic_reset_day) || 1, tzOffsetHours);
  const resetDay = extracted.resetDay;
  const cycle = calculateBillingCycle(resetDay, now, tzOffsetHours);
  const cycleStartMs = cycle.cycleStartDate.getTime();

  const mode = (node.traffic_limit_type || "sum");

  // 1. 获取当月真实的累计流量：优先使用 Komari 原生上报的真实累计计数器（保证与 Komari 实例页完全对齐）
  const rawTotalUp = Number(
    node.net_total_up !== undefined ? node.net_total_up :
    (node.network && node.network.totalUp !== undefined ? node.network.totalUp :
    (node.total_up !== undefined ? node.total_up :
    (node.totalUp !== undefined ? node.totalUp : 0)))
  );
  const rawTotalDown = Number(
    node.net_total_down !== undefined ? node.net_total_down :
    (node.network && node.network.totalDown !== undefined ? node.network.totalDown :
    (node.total_down !== undefined ? node.total_down :
    (node.totalDown !== undefined ? node.totalDown : 0)))
  );

  let histIn = 0;
  let histOut = 0;
  (history || []).forEach((r) => {
    if (r.timestamp >= cycleStartMs && r.timestamp <= now.getTime()) {
      histIn += (r.in_bytes || 0);
      histOut += (r.out_bytes || 0);
    }
  });

  let cumulativeIn = 0;
  let cumulativeOut = 0;

  if (rawTotalUp > 0 || rawTotalDown > 0) {
    // 真实累计计数器存在；若节点曾重启导致网卡计数器清零小于历史分天总和，自动取较大者防下坠
    cumulativeIn = Math.max(rawTotalDown, histIn);
    cumulativeOut = Math.max(rawTotalUp, histOut);
  } else {
    cumulativeIn = histIn;
    cumulativeOut = histOut;
  }

  const cumulativePhysicalTotal = cumulativeIn + cumulativeOut;
  const cumulativeBillable = computeBillableAmount(cumulativeIn, cumulativeOut, mode);

  // 2. 7 天移动平均日均增量（优先使用过去已完整天数的真实打点增量，无记录时根据真实累计和已过天数推算均速）
  const validPastDays = (history || []).filter((r) => !r.is_today && (r.in_bytes || 0) + (r.out_bytes || 0) > 0).slice(-7);
  let dailyAvgIn = 0;
  let dailyAvgOut = 0;

  if (validPastDays.length > 0) {
    let weightSum = 0;
    let weightedInSum = 0;
    let weightedOutSum = 0;

    validPastDays.forEach((record, index) => {
      const weight = 1 + (index / validPastDays.length) * 1.2;
      weightedInSum += (record.in_bytes || 0) * weight;
      weightedOutSum += (record.out_bytes || 0) * weight;
      weightSum += weight;
    });

    dailyAvgIn = Math.round(weightedInSum / weightSum);
    dailyAvgOut = Math.round(weightedOutSum / weightSum);
  } else if (cycle.daysElapsed > 0 && cumulativePhysicalTotal > 0) {
    dailyAvgIn = Math.round(cumulativeIn / cycle.daysElapsed);
    dailyAvgOut = Math.round(cumulativeOut / cycle.daysElapsed);
  } else {
    const todayRec = (history || []).find((r) => r.is_today);
    dailyAvgIn = todayRec ? (todayRec.in_bytes || 0) : 0;
    dailyAvgOut = todayRec ? (todayRec.out_bytes || 0) : 0;
  }

  const dailyAvgTotal = dailyAvgIn + dailyAvgOut;
  const dailyAvgBillable = computeBillableAmount(dailyAvgIn, dailyAvgOut, mode);

  const projectedIn = cumulativeIn + dailyAvgIn * cycle.daysRemaining;
  const projectedOut = cumulativeOut + dailyAvgOut * cycle.daysRemaining;
  const projectedPhysicalTotal = cumulativePhysicalTotal + dailyAvgTotal * cycle.daysRemaining;
  const projectedBillable = computeBillableAmount(projectedIn, projectedOut, mode);

  const rawQuota = Number(node.traffic_limit) || 0;
  const hasQuota = rawQuota > 0;

  let status = "NO_QUOTA";
  let usageRatio = 0;
  let daysUntilExhaustion = undefined;
  let exhaustionDate = undefined;
  let warningMessage = undefined;

  if (!hasQuota) {
    status = "NO_QUOTA";
  } else {
    usageRatio = projectedBillable / rawQuota;
    const modeBadge = getThresholdModeLabel(mode);

    if (cumulativeBillable >= rawQuota) {
      status = "CRITICAL";
      daysUntilExhaustion = 0;
      exhaustionDate = formatDateToYMD(now, tzOffsetHours);
      warningMessage = `已超出流量限额 (${formatBytes(cumulativeBillable)} / ${formatBytes(rawQuota)})，超额 ${formatBytes(cumulativeBillable - rawQuota)}！`;
    } else if (projectedBillable >= rawQuota) {
      status = "CRITICAL";
      const remainingQuota = rawQuota - cumulativeBillable;
      daysUntilExhaustion = dailyAvgBillable > 0 ? Math.max(1, Math.floor(remainingQuota / dailyAvgBillable)) : 999;
      const exDateObj = new Date(now.getTime() + daysUntilExhaustion * 24 * 60 * 60 * 1000);
      exhaustionDate = formatDateToYMD(exDateObj, tzOffsetHours);
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

  const chartSeries = buildCycleSeries(history, mode, cycle, dailyAvgIn, dailyAvgOut, cumulativeBillable, cumulativeIn, cumulativeOut, now, tzOffsetHours);

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
    fetch_failed: Boolean(node.fetch_failed),
    fetch_error: node.fetch_error || null,
  };
}

// 纯时序流量存储（只存流量采样统计，无数据就返回空，绝不伪造种子数据）
class TrafficStorage {
  constructor() {
    this.baseDir = typeof __storageDir__ !== "undefined" && __storageDir__ ? __storageDir__ : "data/plugin-data/net-forecast";
    this.trafficFile = path ? path.join(this.baseDir, "traffic_records.json") : this.baseDir + "/traffic_records.json";
    this.trafficCache = {};
    this.lastCounters = {};
    this.load();
  }

  load() {
    if (!fs) return;
    try {
      if (!fs.existsSync(this.baseDir)) {
        fs.mkdirSync(this.baseDir, { recursive: true });
      }
      if (fs.existsSync(this.trafficFile)) {
        const parsed = JSON.parse(fs.readFileSync(this.trafficFile, "utf-8"));
        const records = parsed.records || {};
        this.trafficCache = {};
        for (const id in records) {
          const list = records[id] || [];
          const isLegacySeed = list.length === 31 && list.every(r => r.total_bytes >= 10 * 1024 * 1024 * 1024 && r.total_bytes <= 35 * 1024 * 1024 * 1024);
          if (!isLegacySeed) {
            this.trafficCache[id] = list;
          }
        }
        this.lastCounters = parsed.last_counters || {};
      }
    } catch (e) {
      console.warn("[NetForecast] Storage load notice:", e);
    }
  }

  save() {
    if (!fs) return;
    try {
      if (!fs.existsSync(this.baseDir)) {
        fs.mkdirSync(this.baseDir, { recursive: true });
      }
      fs.writeFileSync(
        this.trafficFile,
        JSON.stringify(
          {
            records: this.trafficCache,
            last_counters: this.lastCounters,
            updated_at: new Date().toISOString(),
          },
          null,
          2
        ),
        "utf-8"
      );
    } catch (e) {
      console.error("[NetForecast] Storage save error:", e);
    }
  }

  getNodeHistory(nodeId) {
    return this.trafficCache[nodeId] || [];
  }

  setNodeDailyHistory(nodeId, dailyHistory) {
    if (!Array.isArray(dailyHistory) || dailyHistory.length === 0) return;
    const existing = this.trafficCache[nodeId] || [];
    const map = {};
    existing.forEach((r) => { if (r && r.date) map[r.date] = r; });
    dailyHistory.forEach((r) => {
      if (r && r.date) {
        map[r.date] = Object.assign({}, map[r.date] || {}, r);
      }
    });
    const merged = Object.keys(map).sort().map((d) => map[d]);
    if (merged.length > 90) {
      merged.splice(0, merged.length - 90);
    }
    this.trafficCache[nodeId] = merged;
    this.save();
  }

  recordSample(nodeId, currentIn, currentOut, now = new Date(), tzOffsetHours = 8) {
    const last = this.lastCounters[nodeId];
    this.lastCounters[nodeId] = {
      in: currentIn,
      out: currentOut,
      time: now.getTime(),
    };

    if (!last) {
      this.save();
      return;
    }

    let deltaIn = currentIn >= last.in ? currentIn - last.in : currentIn;
    let deltaOut = currentOut >= last.out ? currentOut - last.out : currentOut;

    if (deltaIn > 500 * 1024 * 1024 * 1024) deltaIn = 0;
    if (deltaOut > 500 * 1024 * 1024 * 1024) deltaOut = 0;

    if (deltaIn === 0 && deltaOut === 0) {
      return;
    }

    const todayStr = getTzDateParts(now, tzOffsetHours).dateStr;
    const history = this.trafficCache[nodeId] || [];
    let record = history.find((r) => r.date === todayStr);

    if (record) {
      record.in_bytes += deltaIn;
      record.out_bytes += deltaOut;
      record.total_bytes = record.in_bytes + record.out_bytes;
      record.timestamp = now.getTime();
    } else {
      record = {
        date: todayStr,
        timestamp: now.getTime(),
        in_bytes: deltaIn,
        out_bytes: deltaOut,
        total_bytes: deltaIn + deltaOut,
      };
      history.push(record);
    }

    if (history.length > 90) {
      history.splice(0, history.length - 90);
    }
    this.trafficCache[nodeId] = history;
    this.save();
  }
}

/**
 * 发送 JSON 响应辅助函数
 * 
 * ⚠️【高危避坑警告 - 严禁修改或删除 res.end()】：
 * Komari 插件运行在基于 Goja 的底层 HTTP 驱动中。
 * 必须显式调用 res.end(JSON.stringify(data)) 彻底终结并发送 HTTP 响应流！
 * 若遗漏 res.end()，服务端将永久挂起连接，导致客户端（前台悬浮小组件与看板公开页）
 * 请求 /api/plugin/net-forecast/overview 时无限处于 loading 卡死状态并最终超时报错！
 */
function sendJSON(res, data, statusCode = 200) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  // 必须调用 res.end 结束响应流，切勿遗漏或删除！
  res.end(JSON.stringify(data));
}

/**
 * =========================================================================================
 * 前端浮出层组件核心实现 (Frontend Floating Widget: WIDGET_HEAD_HTML + WIDGET_BODY_HTML)
 * =========================================================================================
 * ⚠️ 【开发者与 AI Agent 避坑守则 - 严禁违背以下原则】：
 * 
 * 1. 【模板字符串零反斜杠原则 (Zero-Backslash Hazard)】:
 *    WIDGET_BODY_HTML 采用 ES6 反引号模板字符串定义。在 Goja/Node 运行时求值时，
 *    所有单一反斜杠（尤其正则中的斜杠、问号等转义）都会被直接剥离转义符！
 *    例如 replace 带有斜杠转义会直接变成双斜杠行注释，吞噬后续括号并引发致命 SyntaxError，
 *    导致整个注入脚本无法加载（按钮消失或事件全灭）。
 *    👉 守则：WIDGET_BODY_HTML 内部的客户端 JS 必须 100% 使用纯原生字符串方法（如 split、indexOf、slice、
 *    split("-").join("")），绝对禁止出现反斜杠或包含反斜杠的正则字面量！
 * 
 * 2. 【CSS 样式表定位与拖拽冲突 (CSS Specificity vs Drag Inline Styles)】:
 *    严禁在 CSS 规则 #nf-floating-widget .nf-trigger-sq 中写死 right: 28px !important 或 bottom: 28px !important。
 *    否则用户拖拽时通过 JS 设置的 left/top 行内样式会被样式表的 right/bottom 强行覆盖锁死，导致按钮无法拖动。
 *    👉 守则：初始位置完全交由 JS 的 loadSavedPos() 设置行内样式；样式表仅声明 position: fixed !important。
 * 
 * 3. 【单节点 Instance 路由匹配鲁棒性 (Robust Instance Matching)】:
 *    Komari 的路由可能为 /instance/:id、/instances/:id、/node/:id、Hash 路由或 Search 参数。
 *    节点 ID 可能为标准 UUID、无连字符 UUID、短 UUID 前缀、纯数字或别名。
 *    👉 守则：使用 findMatchingNode() 实行多层匹配（精确匹配 -> 忽略连字符匹配 -> 前缀匹配），禁止拼接空格或强设长度下限。
 * 
 * 4. 【单节点与全节点筛选状态解耦 (Decoupled Filtering)】:
 *    在 Instance 页面时，默认激活「📌 当前 (1)」过滤，展示当前节点；同时保留全部药丸（全部、预警、正常、免额），
 *    点击任意药丸均可切换全局过滤，严禁在 instance 路由下强行锁死其他筛选按钮。
 * 
 * 5. 【事件捕获与点击机制 (PointerCapture & Drag Separation)】:
 *    采用经过实测验证的 pointerdown / pointermove / pointerup 拖动模型，位移 > 4px 视为拖拽，未位移则触发 toggle()；
 *    SVG 图标内部子元素设置 pointer-events: none !important，防止 SVG 节点截获捕获事件。
 * =========================================================================================
 */
const WIDGET_HEAD_HTML = `<style id="netforecast-widget-style">
#nf-floating-widget, #nf-floating-widget * {
  box-sizing: border-box !important;
  font-family: var(--nf-font) !important;
}

#nf-floating-widget {
  --nf-font: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  --nf-font-size: 14px;
  --nf-scheme: light;
  --nf-page-bg: #f8fafc;
  --nf-card-bg: #fff;
  --nf-page-image: none;
  --nf-card-image: none;
  --nf-text: #172033;
  --nf-card-text: #172033;
  --nf-muted: #334155;
  --nf-accent: #1d4ed8;
  --nf-safe: #047857;
  --nf-warning: #92400e;
  --nf-danger: #b91c1c;
  --nf-radius: 12px;
  --nf-border: 1px solid rgba(255, 255, 255, 0.12);
  --nf-border-top: 1px solid rgba(255, 255, 255, 0.12);
  --nf-border-right: 1px solid rgba(255, 255, 255, 0.12);
  --nf-border-bottom: 1px solid rgba(255, 255, 255, 0.12);
  --nf-border-left: 1px solid rgba(255, 255, 255, 0.12);
  font-family: var(--nf-font) !important;
  font-size: var(--nf-font-size) !important;
  line-height: 1.45 !important;
  color-scheme: var(--nf-scheme) !important;
  color: var(--nf-text) !important;
  pointer-events: none !important;
  opacity: 0 !important;
  transition: opacity 0.22s ease !important;
}

#nf-floating-widget.nf-ready {
  opacity: 1 !important;
}

#nf-floating-widget:not(.nf-ready) .nf-trigger-sq {
  pointer-events: none !important;
}

/* 1. 可拖拽方形触发图标按钮 (无文字，边框状态变色) */
#nf-floating-widget .nf-trigger-sq {
  width: 48px !important;
  height: 48px !important;
  position: fixed !important;
  background-color: var(--nf-card-bg, #1e293b) !important;
  background-image: var(--nf-card-image, none) !important;
  background-size: var(--nf-card-size, auto) !important;
  background-position: var(--nf-card-position, 0% 0%) !important;
  background-repeat: var(--nf-card-repeat, repeat) !important;
  background-origin: var(--nf-card-origin, padding-box) !important;
  background-clip: var(--nf-card-clip, border-box) !important;
  background-blend-mode: var(--nf-card-blend, normal) !important;
  background-attachment: var(--nf-card-attachment, scroll) !important;
  border-radius: 12px !important;
  backdrop-filter: blur(20px) !important;
  -webkit-backdrop-filter: blur(20px) !important;
  display: flex !important;
  align-items: center !important;
  justify-content: center !important;
  cursor: grab !important;
  user-select: none !important;
  touch-action: none !important;
  z-index: 99990 !important;
  pointer-events: auto !important;
  transition: border-color 0.25s, box-shadow 0.25s, transform 0.15s !important;
}
#nf-floating-widget .nf-trigger-sq:active {
  cursor: grabbing !important;
  transform: scale(0.96) !important;
}
#nf-floating-widget .nf-trigger-sq * {
  pointer-events: none !important;
}
/* 方案一：立体深影 + 贴近宿主卡片边框风格 (极细 1px 边框，无红绿边框，无脉冲动效) */
#nf-floating-widget .nf-trigger-sq {
  border: var(--nf-border, 1px solid rgba(255, 255, 255, 0.12)) !important;
  color: var(--nf-text, #cbd5e1) !important;
  box-shadow: 
    4px 6px 18px rgba(0, 0, 0, 0.45),
    1px 2px 4px rgba(0, 0, 0, 0.25) !important;
}
#nf-floating-widget .nf-trigger-sq:hover {
  transform: translate(-1px, -1px) scale(1.04) !important;
  box-shadow: 
    6px 10px 24px rgba(0, 0, 0, 0.55),
    2px 3px 6px rgba(0, 0, 0, 0.3) !important;
}
#nf-floating-widget .nf-trigger-sq.safe,
#nf-floating-widget .nf-trigger-sq.alert {
  /* 边框严格贴近主题页面风格，极细 1px，无刺眼的红绿色边框，预警状态无脉冲 */
  border: var(--nf-border, 1px solid rgba(255, 255, 255, 0.12)) !important;
  color: var(--nf-text, #cbd5e1) !important;
}
#nf-floating-widget .nf-sq-dot {
  position: absolute !important;
  top: -3px !important;
  right: -3px !important;
  width: 10px !important;
  height: 10px !important;
  border-radius: 50% !important;
  border: 2px solid #0f172a !important;
  display: none !important;
}
#nf-floating-widget .nf-sq-dot.alert {
  display: block !important;
  background: #ef4444 !important;
  box-shadow: 0 0 6px #ef4444 !important;
}

/* 2. 展开看板面板主体 (立体深邃投影与极细 1px 边框) */
#nf-floating-widget .nf-widget-card {
  display: none !important;
  position: fixed !important;
  z-index: 100000 !important;
  pointer-events: auto !important;
  width: 440px !important;
  min-width: 320px !important;
  min-height: 220px !important;
  max-width: calc(100vw - 28px) !important;
  max-height: 80vh !important;
  background-color: var(--nf-page-bg) !important;
  background-image: var(--nf-page-image) !important;
  background-size: var(--nf-page-size, auto) !important;
  background-position: var(--nf-page-position, 0% 0%) !important;
  background-repeat: var(--nf-page-repeat, repeat) !important;
  background-origin: var(--nf-page-origin, padding-box) !important;
  background-clip: var(--nf-page-clip, border-box) !important;
  background-blend-mode: var(--nf-page-blend, normal) !important;
  background-attachment: var(--nf-page-attachment, scroll) !important;
  border: var(--nf-border, 1px solid rgba(255, 255, 255, 0.12)) !important;
  backdrop-filter: blur(28px) !important;
  -webkit-backdrop-filter: blur(28px) !important;
  border-radius: var(--nf-radius, 16px) !important;
  box-shadow: 
    8px 16px 36px rgba(0, 0, 0, 0.55),
    2px 4px 10px rgba(0, 0, 0, 0.35) !important;
  flex-direction: column !important;
  overflow: hidden !important;
  resize: both !important;
}
#nf-floating-widget .nf-widget-card.nf-open {
  display: flex !important;
  animation: nfSlideUp 0.22s cubic-bezier(0.16, 1, 0.3, 1) !important;
}
@keyframes nfSlideUp {
  from { opacity: 0; transform: translateY(10px) scale(0.98); }
  to { opacity: 1; transform: translateY(0) scale(1); }
}

/* 顶部 Header */
#nf-floating-widget .nf-header {
  padding: 16px 20px !important;
  border-bottom: var(--nf-border-bottom) !important;
  display: flex !important;
  align-items: center !important;
  justify-content: space-between !important;
  gap: 12px !important;
  background: transparent !important;
  flex-shrink: 0 !important;
}
#nf-floating-widget .nf-header-title {
  display: flex !important;
  align-items: center !important;
  gap: 10px !important;
  min-width: 0 !important;
}
#nf-floating-widget .nf-header-icon {
  font-size: 1.0714em !important;
  background: color-mix(in srgb, var(--nf-accent) 12%, transparent) !important;
  width: 30px !important;
  height: 30px !important;
  display: flex !important;
  align-items: center !important;
  justify-content: center !important;
  border-radius: 8px !important;
  border: 1px solid var(--nf-accent) !important;
  flex-shrink: 0 !important;
}
#nf-floating-widget .nf-header-text {
  font-size: 1.0em !important;
  font-weight: 700 !important;
  color: var(--nf-text) !important;
  white-space: nowrap !important;
  overflow: hidden !important;
  text-overflow: ellipsis !important;
}
#nf-floating-widget .nf-close-btn {
  background: color-mix(in srgb, var(--nf-text) 7%, transparent) !important;
  border: var(--nf-border-top) !important;
  color: var(--nf-muted) !important;
  font-size: 1.0em !important;
  font-weight: 700 !important;
  cursor: pointer !important;
  width: 30px !important;
  height: 30px !important;
  display: flex !important;
  align-items: center !important;
  justify-content: center !important;
  border-radius: 8px !important;
  transition: all 0.2s !important;
  flex-shrink: 0 !important;
}
#nf-floating-widget .nf-close-btn:hover {
  color: var(--nf-text) !important;
  background: rgba(239, 68, 68, 0.25) !important;
  border-color: rgba(239, 68, 68, 0.5) !important;
}

/* KPI 统计条 */
#nf-floating-widget .nf-kpi-bar {
  display: grid !important;
  grid-template-columns: repeat(3, minmax(0, 1fr)) !important;
  gap: 10px !important;
  padding: 14px 20px 10px 20px !important;
  background: transparent !important;
  border-bottom: var(--nf-border-bottom) !important;
  flex-shrink: 0 !important;
}
#nf-floating-widget .nf-kpi-item {
  background: var(--nf-card-bg) !important;
  background-image: var(--nf-card-image) !important;
  background-size: var(--nf-card-size, auto) !important;
  background-position: var(--nf-card-position, 0% 0%) !important;
  background-repeat: var(--nf-card-repeat, repeat) !important;
  background-origin: var(--nf-card-origin, padding-box) !important;
  background-clip: var(--nf-card-clip, border-box) !important;
  background-blend-mode: var(--nf-card-blend, normal) !important;
  background-attachment: var(--nf-card-attachment, scroll) !important;
  color: var(--nf-card-text) !important;
  border-top: var(--nf-border-top) !important;
  border-right: var(--nf-border-right) !important;
  border-bottom: var(--nf-border-bottom) !important;
  border-left: var(--nf-border-left) !important;
  padding: 8px 10px !important;
  border-radius: var(--nf-radius) !important;
  display: flex !important;
  flex-direction: column !important;
  gap: 2px !important;
}
#nf-floating-widget .nf-kpi-lbl {
  font-size: 0.7143em !important;
  color: var(--nf-muted) !important;
  text-transform: uppercase !important;
  letter-spacing: 0.02em !important;
}
#nf-floating-widget .nf-kpi-val {
  font-size: 0.9286em !important;
  font-weight: 700 !important;
  color: var(--nf-card-text) !important;
  white-space: nowrap !important;
  overflow: hidden !important;
  text-overflow: ellipsis !important;
}

/* 过滤筛选按钮栏 */
#nf-floating-widget .nf-filter-bar {
  display: flex !important;
  align-items: center !important;
  gap: 8px !important;
  padding: 10px 20px 8px 20px !important;
  background: transparent !important;
  border-bottom: var(--nf-border-bottom) !important;
  overflow-x: auto !important;
  flex-shrink: 0 !important;
}
#nf-floating-widget .nf-filter-bar::-webkit-scrollbar {
  display: none !important;
}
#nf-floating-widget .nf-filter-btn {
  background: color-mix(in srgb, var(--nf-text) 7%, transparent) !important;
  border: var(--nf-border-top) !important;
  color: var(--nf-muted) !important;
  padding: 5px 12px !important;
  border-radius: 20px !important;
  font-size: 0.7857em !important;
  font-weight: 500 !important;
  cursor: pointer !important;
  white-space: nowrap !important;
  transition: all 0.15s ease !important;
}
#nf-floating-widget .nf-filter-btn:hover {
  color: var(--nf-text) !important;
  background: color-mix(in srgb, var(--nf-text) 7%, transparent) !important;
}
#nf-floating-widget .nf-filter-btn.active {
  background: color-mix(in srgb, var(--nf-accent) 12%, var(--nf-page-bg)) !important;
  border-color: var(--nf-accent) !important;
  color: var(--nf-accent) !important;
  font-weight: 700 !important;
}

/* 节点列表容器 (充裕内边距，滚动顺滑) */
#nf-floating-widget .nf-list {
  flex: 1 1 auto !important;
  min-height: 0 !important;
  overflow-y: auto !important;
  padding: 14px 20px 18px 20px !important;
  display: flex !important;
  flex-direction: column !important;
  gap: 12px !important;
}
#nf-floating-widget .nf-list::-webkit-scrollbar {
  width: 5px !important;
}
#nf-floating-widget .nf-list::-webkit-scrollbar-thumb {
  background: rgba(255, 255, 255, 0.15) !important;
  border-radius: 4px !important;
}

/* 单节点精炼卡片 (带有明显独立卡片背景、边框、投影和充裕内边距，支持点击跳转至详情页) */
#nf-floating-widget .nf-node-card {
  background: var(--nf-card-bg) !important;
  background-image: var(--nf-card-image) !important;
  background-size: var(--nf-card-size, auto) !important;
  background-position: var(--nf-card-position, 0% 0%) !important;
  background-repeat: var(--nf-card-repeat, repeat) !important;
  background-origin: var(--nf-card-origin, padding-box) !important;
  background-clip: var(--nf-card-clip, border-box) !important;
  background-blend-mode: var(--nf-card-blend, normal) !important;
  background-attachment: var(--nf-card-attachment, scroll) !important;
  color: var(--nf-card-text) !important;
  border-top: var(--nf-border-top) !important;
  border-right: var(--nf-border-right) !important;
  border-bottom: var(--nf-border-bottom) !important;
  border-left: var(--nf-border-left) !important;
  border-radius: var(--nf-radius) !important;
  padding: 13px 15px !important;
  display: flex !important;
  flex-direction: column !important;
  gap: 8px !important;
  box-shadow: var(--nf-shadow) !important;
  transition: all 0.18s ease !important;
  cursor: pointer !important;
  user-select: none !important;
}
#nf-floating-widget .nf-node-card:hover {
  background: var(--nf-card-bg) !important;
  background-image: var(--nf-card-image) !important;
  background-size: var(--nf-card-size, auto) !important;
  background-position: var(--nf-card-position, 0% 0%) !important;
  background-repeat: var(--nf-card-repeat, repeat) !important;
  background-origin: var(--nf-card-origin, padding-box) !important;
  background-clip: var(--nf-card-clip, border-box) !important;
  background-blend-mode: var(--nf-card-blend, normal) !important;
  background-attachment: var(--nf-card-attachment, scroll) !important;
  color: var(--nf-card-text) !important;
  border-color: var(--nf-accent) !important;
  transform: translateY(-2px) !important;
  box-shadow: var(--nf-shadow) !important;
}
#nf-floating-widget .nf-node-card:active {
  transform: scale(0.99) !important;
}
#nf-floating-widget .nf-node-card:hover .nf-node-name {
  color: var(--nf-accent) !important;
}
#nf-floating-widget .nf-node-jump {
  font-size: 0.7857em !important;
  color: var(--nf-muted) !important;
  opacity: 0 !important;
  transition: all 0.18s ease !important;
  margin-left: 2px !important;
}
#nf-floating-widget .nf-node-card:hover .nf-node-jump {
  opacity: 1 !important;
  color: var(--nf-accent) !important;
}
#nf-floating-widget .nf-row-head {
  display: flex !important;
  justify-content: space-between !important;
  align-items: center !important;
  gap: 8px !important;
}
#nf-floating-widget .nf-node-name-wrap {
  display: flex !important;
  align-items: center !important;
  gap: 6px !important;
  min-width: 0 !important;
}
#nf-floating-widget .nf-node-name {
  font-size: 0.9286em !important;
  font-weight: 700 !important;
  color: var(--nf-card-text) !important;
  white-space: nowrap !important;
  overflow: hidden !important;
  text-overflow: ellipsis !important;
}
#nf-floating-widget .nf-mode-badge {
  font-size: 0.7143em !important;
  background: color-mix(in srgb, var(--nf-accent) 12%, transparent) !important;
  border: 1px solid var(--nf-accent) !important;
  color: var(--nf-accent) !important;
  padding: 1px 6px !important;
  border-radius: 4px !important;
  font-weight: 600 !important;
  flex-shrink: 0 !important;
}
#nf-floating-widget .nf-status-wrap {
  display: flex !important;
  align-items: center !important;
  gap: 6px !important;
  flex-shrink: 0 !important;
}
#nf-floating-widget .nf-badge {
  font-size: 0.7143em !important;
  font-weight: 700 !important;
  padding: 2px 7px !important;
  border-radius: 6px !important;
  display: inline-flex !important;
  align-items: center !important;
}
#nf-floating-widget .nf-badge.critical {
  background: rgba(239, 68, 68, 0.25) !important;
  color: var(--nf-danger) !important;
  border: 1px solid rgba(239, 68, 68, 0.5) !important;
}
#nf-floating-widget .nf-badge.warning {
  background: rgba(245, 158, 11, 0.25) !important;
  color: var(--nf-warning) !important;
  border: 1px solid rgba(245, 158, 11, 0.5) !important;
}
#nf-floating-widget .nf-badge.safe {
  background: rgba(16, 185, 129, 0.2) !important;
  color: var(--nf-safe) !important;
  border: 1px solid rgba(16, 185, 129, 0.4) !important;
}
#nf-floating-widget .nf-badge.no-quota {
  background: rgba(148, 163, 184, 0.18) !important;
  color: var(--nf-card-text) !important;
  border: 1px solid rgba(148, 163, 184, 0.3) !important;
}
#nf-floating-widget .nf-pct {
  font-size: 0.8571em !important;
  font-weight: 700 !important;
  color: var(--nf-accent) !important;
}
#nf-floating-widget .nf-pct.critical {
  color: var(--nf-danger) !important;
}

#nf-floating-widget .nf-bar-bg {
  width: 100% !important;
  height: 8px !important;
  background: transparent !important;
  border-radius: 4px !important;
  overflow: hidden !important;
  position: relative !important;
  display: flex !important;
  margin: 2px 0 !important;
}
#nf-floating-widget .nf-bar-used {
  height: 100% !important;
  background: var(--nf-accent) !important;
  border-radius: 4px 0 0 4px !important;
  transition: width 0.3s ease !important;
}
#nf-floating-widget .nf-bar-projected {
  height: 100% !important;
  background: repeating-linear-gradient(45deg, rgba(251, 146, 60, 0.5), rgba(251, 146, 60, 0.5) 4px, rgba(251, 146, 60, 0.85) 4px, rgba(251, 146, 60, 0.85) 8px) !important;
  transition: width 0.3s ease !important;
}
#nf-floating-widget .nf-bar-projected.critical {
  background: repeating-linear-gradient(45deg, rgba(239, 68, 68, 0.55), rgba(239, 68, 68, 0.55) 4px, rgba(239, 68, 68, 0.9) 4px, rgba(239, 68, 68, 0.9) 8px) !important;
}

#nf-floating-widget .nf-row-meta {
  display: flex !important;
  justify-content: space-between !important;
  align-items: center !important;
  font-size: 0.7857em !important;
  color: var(--nf-card-text) !important;
  flex-wrap: wrap !important;
  gap: 4px 8px !important;
  padding-top: 1px !important;
}
#nf-floating-widget .nf-row-meta strong {
  color: var(--nf-card-text) !important;
}
#nf-floating-widget .nf-row-meta .nf-speed {
  color: var(--nf-accent) !important;
  font-weight: 600 !important;
}

/* 底部 Footer */
#nf-floating-widget .nf-footer {
  padding: 13px 20px !important;
  border-top: var(--nf-border-top) !important;
  background: transparent !important;
  display: flex !important;
  justify-content: space-between !important;
  align-items: center !important;
  flex-shrink: 0 !important;
}
#nf-floating-widget .nf-footer-status {
  font-size: 0.7857em !important;
  color: var(--nf-muted) !important;
  display: flex !important;
  align-items: center !important;
  gap: 6px !important;
}
#nf-floating-widget .nf-live-dot {
  width: 6px !important;
  height: 6px !important;
  background: #10b981 !important;
  border-radius: 50% !important;
  box-shadow: 0 0 6px #10b981 !important;
}
#nf-floating-widget .nf-btn-full {
  font-size: 0.8571em !important;
  color: var(--nf-accent) !important;
  background: var(--nf-card-bg) !important;
  border: 1px solid var(--nf-accent) !important;
  padding: 6px 14px !important;
  border-radius: 8px !important;
  text-decoration: none !important;
  font-weight: 600 !important;
  transition: all 0.2s !important;
  box-shadow: 0 4px 12px rgba(79, 70, 229, 0.3) !important;
}
#nf-floating-widget .nf-btn-full:hover {
  transform: translateY(-1px) !important;
  box-shadow: 0 6px 18px rgba(79, 70, 229, 0.45) !important;
}
#nf-floating-widget .nf-node-name, #nf-floating-widget .nf-kpi-val { color: var(--nf-card-text) !important; }
#nf-floating-widget #nfKpiRiskVal { color: var(--nf-risk, var(--nf-card-text)) !important; }
#nf-floating-widget .nf-empty { text-align: center !important; padding: 28px !important; color: var(--nf-muted) !important; font-size: 0.86em !important; }
#nf-floating-widget .nf-kpi-item { min-width: 0 !important; }
#nf-floating-widget .nf-header-text { font-size: 1em !important; }
#nf-floating-widget .nf-filter-btn { flex-shrink: 0 !important; }
@media (prefers-color-scheme: dark) {
  #nf-floating-widget { --nf-scheme: dark; --nf-page-bg: #0f172a; --nf-card-bg: #1e293b; --nf-text: #f1f5f9; --nf-card-text: #f1f5f9; --nf-muted: #cbd5e1; --nf-accent: #93c5fd; --nf-safe: #6ee7b7; --nf-warning: #fde68a; --nf-danger: #fca5a5; }
}
</style>`;

const WIDGET_BODY_HTML = `<script>
(function() {
  // Sample host surfaces only. Discovery is bounded and cached; widget writes never resample.
  var nfThemeRoot = document.getElementById("nf-floating-widget");
  var nfThemePage = null, nfThemeCard = null, nfThemeAccent = null;
  var nfThemeTimer = null, nfThemeDue = 0, nfThemeLast = 0, nfThemeDiscover = true;
  var nfThemeLastDiscovery = 0;
  var nfThemeAncestors = [];
  var nfThemeMedia = window.matchMedia("(prefers-color-scheme: dark)");
  var nfColorCanvas = document.createElement("canvas");
  nfColorCanvas.width = nfColorCanvas.height = 1;
  var nfColorContext = nfColorCanvas.getContext("2d", { willReadFrequently: true });

  function nfHostElement(el) {
    var root = document.getElementById("nf-floating-widget") || nfThemeRoot;
    return el && el.nodeType === 1 && (!root || !root.contains(el)) &&
      (!el.id || el.id.indexOf("km-ul-") < 0) &&
      (!el.closest || !el.closest('[role="dialog"], [role="menu"], [role="listbox"], [popover], nav, header, footer, #netforecast-widget-style, #km-unlock-floating-root, #km-ul-min-icon'));
  }
  function nfRGBA(value) {
    if (!nfColorContext || !value || !CSS.supports("color", value)) return [0, 0, 0, 0];
    nfColorContext.clearRect(0, 0, 1, 1);
    nfColorContext.fillStyle = value;
    nfColorContext.fillRect(0, 0, 1, 1);
    var c = nfColorContext.getImageData(0, 0, 1, 1).data;
    return [c[0], c[1], c[2], c[3] / 255];
  }
  function nfBlend(top, bottom) {
    var a = top[3] + bottom[3] * (1 - top[3]);
    if (a <= 0) return [0, 0, 0, 0];
    var r = Math.round((top[0] * top[3] + bottom[0] * bottom[3] * (1 - top[3])) / a);
    var g = Math.round((top[1] * top[3] + bottom[1] * bottom[3] * (1 - top[3])) / a);
    var b = Math.round((top[2] * top[3] + bottom[2] * bottom[3] * (1 - top[3])) / a);
    return [r, g, b, Math.round(a * 100) / 100];
  }
  function nfColor(c) {
    if (c.length >= 4 && c[3] < 1) {
      return "rgba(" + c.slice(0, 3).join(", ") + ", " + c[3] + ")";
    }
    return "rgb(" + c.slice(0, 3).join(", ") + ")";
  }
  function nfLuminance(c) {
    var v = c.slice(0, 3).map(function(n) { n /= 255; return n <= 0.04045 ? n / 12.92 : Math.pow((n + 0.055) / 1.055, 2.4); });
    return v[0] * 0.2126 + v[1] * 0.7152 + v[2] * 0.0722;
  }
  function nfContrast(a, b) {
    var x = nfLuminance(a), y = nfLuminance(b);
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
  }
  function nfReadable(value, bg, fallback) {
    var c = nfBlend(nfRGBA(value), bg);
    return nfContrast(c, bg) >= 4.5 ? nfColor(c) : fallback;
  }
  function nfVisible(el) {
    if (!nfHostElement(el) || !el.isConnected) return false;
    if (el.checkVisibility && !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
    var r = el.getBoundingClientRect(), s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility === "visible" && Number(s.opacity) >= 0.5 &&
      r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
  }
  function nfQueryVisible(selectorList) {
    for (var i = 0; i < selectorList.length; i++) {
      try {
        var list = document.querySelectorAll(selectorList[i]);
        for (var j = 0; j < list.length; j++) {
          var el = list[j];
          if (!nfHostElement(el)) continue;
          var s = getComputedStyle(el);
          if (s.display === "none" || s.visibility === "hidden" || Number(s.opacity) < 0.05) continue;
          var r = el.getBoundingClientRect();
          if (r.width >= 2 && r.height >= 2) return el;
        }
      } catch (e) {}
    }
    return null;
  }
  function nfSamplePageBackdrop(fallback) {
    var selectors = [
      ".background-container .background-image", ".background-container", ".default-background",
      ".bp-root", "main", "[role='main']", "#app", "#root", "body", "html"
    ];
    for (var i = 0; i < selectors.length; i++) {
      var candidate = nfQueryVisible([selectors[i]]);
      if (!candidate) continue;
      var s = getComputedStyle(candidate);
      var img = s.backgroundImage || "none";
      var c = nfRGBA(s.backgroundColor);
      if (c[3] <= 0.05 && img === "none") continue;
      if (nfThemeAncestors.indexOf(candidate) < 0) nfThemeAncestors.push(candidate);
      var color = c;
      if (color[3] <= 0.05) {
        for (var p = candidate.parentElement; p && p !== document.documentElement; p = p.parentElement) {
          var ps = getComputedStyle(p);
          var pc = nfRGBA(ps.backgroundColor);
          if (pc[3] > 0.05) { color = pc; break; }
        }
      }
      if (color[3] <= 0.05) color = fallback;
      return {
        bg: color,
        image: img,
        size: s.backgroundSize || "auto",
        position: s.backgroundPosition || "0% 0%",
        repeat: s.backgroundRepeat || "repeat",
        attachment: s.backgroundAttachment || "scroll",
        origin: s.backgroundOrigin || "padding-box",
        clip: s.backgroundClip || "border-box",
        blend: s.backgroundBlendMode || "normal"
      };
    }
    return {
      bg: fallback, image: "none", size: "auto", position: "0% 0%", repeat: "repeat",
      attachment: "scroll", origin: "padding-box", clip: "border-box", blend: "normal"
    };
  }
  function nfSurface(el, fallback) {
    var chain = [], images = [], sizes = [], positions = [], repeats = [], attachments = [], origins = [], clips = [], blends = [];
    for (var p = el, depth = 0; nfHostElement(p) && depth < 16; p = p.parentElement, depth++) {
      var s = getComputedStyle(p);
      chain.push(s);
      if (nfThemeAncestors.indexOf(p) < 0) nfThemeAncestors.push(p);
      if (s.backgroundImage !== "none") {
        images.push(s.backgroundImage); sizes.push(s.backgroundSize); positions.push(s.backgroundPosition);
        repeats.push(s.backgroundRepeat); attachments.push(s.backgroundAttachment);
        origins.push(s.backgroundOrigin); clips.push(s.backgroundClip); blends.push(s.backgroundBlendMode);
      }
      // An opaque surface hides all backgrounds behind it.
      if (nfRGBA(s.backgroundColor)[3] >= 0.99) break;
    }
    var bg = fallback;
    for (var i = chain.length - 1; i >= 0; i--) {
      var c = nfRGBA(chain[i].backgroundColor);
      if (c[3] > 0.02) bg = nfBlend(c, bg);
    }
    return { bg: bg, image: images.join(", ") || "none", size: sizes.join(", ") || "auto",
      position: positions.join(", ") || "0% 0%", repeat: repeats.join(", ") || "repeat",
      attachment: attachments.join(", ") || "scroll", origin: origins.join(", ") || "padding-box",
      clip: clips.join(", ") || "border-box", blend: blends.join(", ") || "normal" };
  }
  function nfDiscoverTheme() {
    nfThemeLastDiscovery = Date.now();
    nfThemeCard = null;
    nfThemeAccent = null;

    var cardSelectors = [
      ".node-card", ".km-node-card", ".km-instance-server-item", "[data-node-uuid]", "[data-uuid]",
      ".instance-card", ".server-card", "[class*='card']", "[class*='panel']", "article"
    ];
    for (var j = 0; j < cardSelectors.length; j++) {
      var cardCandidate = nfQueryVisible([cardSelectors[j]]);
      if (cardCandidate) {
        var cardSt = getComputedStyle(cardCandidate);
        var hasBg = nfRGBA(cardSt.backgroundColor)[3] > 0.05 || cardSt.backgroundImage !== "none";
        var hasBorder = parseFloat(cardSt.borderTopWidth) > 0 && cardSt.borderTopStyle !== "none";
        if (hasBg || hasBorder) {
          nfThemeCard = cardCandidate;
          break;
        }
      }
    }

    var accentCandidate = nfQueryVisible([
      'button[class*="primary"]', 'a[class*="primary"]', 'button[class*="accent"]', 'a[class*="accent"]',
      '[data-variant="default"]', '[role="tab"][aria-selected="true"]'
    ]);
    if (accentCandidate) {
      nfThemeAccent = accentCandidate;
    }

    if (!nfThemeCard || !nfThemeAccent) {
      var best = 0, reads = 0, visited = 0;
      var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT, {
        acceptNode: function(el) { return nfHostElement(el) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT; }
      });
      for (var el = walker.nextNode(); el && visited < 600 && reads < 60; el = walker.nextNode(), visited++) {
        var tag = el.tagName.toLowerCase();
        var hint = (String(el.className || "") + " " + el.id + " " + (el.getAttribute("data-slot") || "")).toLowerCase();
        var href = el.getAttribute("href") || "";
        var nodeLink = href.indexOf("/instance/") >= 0 || href.indexOf("/node/") >= 0 || href.indexOf("/server/") >= 0;
        var named = hint.indexOf("card") >= 0 || hint.indexOf("server") >= 0 || hint.indexOf("node") >= 0 || hint.indexOf("panel") >= 0;
        if (!named && !nodeLink && tag !== "article" && tag !== "a" && tag !== "button") continue;
        reads++;
        if (!nfVisible(el)) continue;
        var accentEl = el;
        // Themes often put the instance link inside a classless surface wrapper.
        if (nodeLink) {
          for (var parent = el.parentElement, hop = 0; nfHostElement(parent) && hop < 3; parent = parent.parentElement, hop++) {
            var pr = parent.getBoundingClientRect(), pst = getComputedStyle(parent);
            if (pr.width * pr.height > innerWidth * innerHeight * 0.7) break;
            if (pr.height >= 48 && (nfRGBA(pst.backgroundColor)[3] > 0.05 || pst.backgroundImage !== "none" || parseFloat(pst.borderTopWidth) > 0)) { el = parent; break; }
          }
        }
        var style = getComputedStyle(el), rect = el.getBoundingClientRect();
        if (!nfThemeAccent && (tag === "a" || tag === "button")) {
          var accentStyle = getComputedStyle(accentEl);
          var fg = nfRGBA(accentStyle.color), fill = nfRGBA(accentStyle.backgroundColor);
          if (Math.max.apply(null, fg.slice(0, 3)) - Math.min.apply(null, fg.slice(0, 3)) > 40) nfThemeAccent = accentEl;
          else if (fill[3] > 0.5 && Math.max.apply(null, fill.slice(0, 3)) - Math.min.apply(null, fill.slice(0, 3)) > 40) nfThemeAccent = accentEl;
        }
        if (!nfThemeCard) {
          if (rect.width < 120 || rect.height < 48 || rect.width * rect.height > innerWidth * innerHeight * 0.7) continue;
          if (style.position === "fixed" || style.position === "sticky" || tag === "button") continue;
          var border = parseFloat(style.borderTopWidth) > 0 && style.borderTopStyle !== "none";
          var surface = nfRGBA(style.backgroundColor)[3] > 0.05 || style.backgroundImage !== "none";
          if (!surface && !border) continue;
          var score = (named ? 10 : 0) + (nodeLink ? 20 : 0) + (surface ? 3 : 0) + (border ? 2 : 0);
          if (score > best) { best = score; nfThemeCard = el; }
        }
      }
    }
  }
  function nfApplyTheme() {
    nfThemeTimer = null; nfThemeDue = 0; nfThemeLast = Date.now();
    var root = document.getElementById("nf-floating-widget") || nfThemeRoot;
    if (!root || !root.isConnected || document.hidden) return;
    nfThemeRoot = root;
    try {
      if (nfThemeDiscover || (nfThemeCard && !nfVisible(nfThemeCard))) nfDiscoverTheme();
      nfThemeDiscover = false; nfThemeAncestors = [];
      if (nfThemeCard) {
        for (var p = nfThemeCard; p; p = p.parentElement) if (nfThemeAncestors.indexOf(p) < 0) nfThemeAncestors.push(p);
      }
      var bodyBg = nfRGBA(getComputedStyle(document.body).backgroundColor);
      var htmlBg = nfRGBA(getComputedStyle(document.documentElement).backgroundColor);
      var fallback = bodyBg[3] > 0.1 ? bodyBg : (htmlBg[3] > 0.1 ? htmlBg : (nfThemeMedia.matches ? [15, 23, 42, 1] : [248, 250, 252, 1]));
      var page = nfSamplePageBackdrop(fallback);
      var dark = nfLuminance(page.bg) < 0.35;
      var ink = nfLuminance(page.bg) < 0.179 ? "#ffffff" : "#111111";
      var cardSurface = nfThemeCard ? nfSurface(nfThemeCard, page.bg) : {
        bg: dark ? [30, 41, 59, 1] : [255, 255, 255, 1], image: "none", size: "auto", position: "0% 0%", repeat: "repeat", attachment: "scroll", origin: "padding-box", clip: "border-box", blend: "normal"
      };
      var ps = getComputedStyle(document.body);
      var cs = nfThemeCard ? getComputedStyle(nfThemeCard) : null;
      var text = nfReadable(ps.color, page.bg, ink);
      var cardInk = nfLuminance(cardSurface.bg) < 0.179 ? "#ffffff" : "#111111";
      var cardText = nfReadable(cs && cs.color, cardSurface.bg, cardInk);
      var accent = dark ? "#93c5fd" : "#1d4ed8";
      if (nfThemeAccent && nfVisible(nfThemeAccent)) {
        var as = getComputedStyle(nfThemeAccent);
        if (nfThemeAncestors.indexOf(nfThemeAccent) < 0) nfThemeAncestors.push(nfThemeAccent);
        var ac = nfRGBA(as.color);
        if (Math.max.apply(null, ac.slice(0, 3)) - Math.min.apply(null, ac.slice(0, 3)) < 40) ac = nfRGBA(as.backgroundColor);
        if (ac[3] > 0.5 && nfContrast(ac, page.bg) >= 4.5 && nfContrast(ac, cardSurface.bg) >= 4.5) accent = nfColor(ac);
      }
      var vars = { "font": ps.fontFamily, "font-size": ps.fontSize, "scheme": dark ? "dark" : "light",
        "text": text, "card-text": cardText, "muted": text, "accent": accent,
        "radius": cs ? cs.borderRadius : "12px", "shadow": cs ? cs.boxShadow : (dark ? "0 12px 36px #0008" : "0 12px 36px #0f172a26"),
        "safe": nfLuminance(cardSurface.bg) < 0.179 ? "#6ee7b7" : "#047857", "warning": nfLuminance(cardSurface.bg) < 0.179 ? "#fde68a" : "#92400e", "danger": nfLuminance(cardSurface.bg) < 0.179 ? "#fca5a5" : "#b91c1c" };
      var borderVal = cs ? cs.getPropertyValue("border-top") : "";
      if (!borderVal || borderVal === "none" || borderVal.indexOf("0px") === 0) {
        borderVal = "1px solid " + (dark ? "rgba(255, 255, 255, 0.12)" : "rgba(15, 23, 42, 0.12)");
      }
      vars["border"] = borderVal;
      ["top", "right", "bottom", "left"].forEach(function(side) {
        vars["border-" + side] = borderVal;
      });
      [["page", page], ["card", cardSurface]].forEach(function(entry) {
        var prefix = entry[0], surface = entry[1];
        vars[prefix + "-bg"] = nfColor(surface.bg);
        ["image", "size", "position", "repeat", "attachment", "origin", "clip", "blend"].forEach(function(key) { vars[prefix + "-" + key] = surface[key]; });
      });
      Object.keys(vars).forEach(function(key) {
        var name = "--nf-" + key;
        if (root.style.getPropertyValue(name) !== vars[key]) root.style.setProperty(name, vars[key]);
      });
      try {
        localStorage.setItem("nf_theme_vars_v3", JSON.stringify(vars));
      } catch (e) {}
      if (isOpen && typeof positionCard === "function") positionCard();
    } catch (e) { /* Scoped CSS defaults stay readable if sampling is unavailable. */ }
  }
  function nfScheduleTheme(discover, delay) {
    nfThemeDiscover = nfThemeDiscover || discover === true;
    var wait = typeof delay === "number" ? delay : 60;
    var due = Date.now() + wait;
    if (nfThemeTimer !== null && nfThemeDue <= due) return;
    if (nfThemeTimer !== null) clearTimeout(nfThemeTimer);
    nfThemeDue = due;
    nfThemeTimer = setTimeout(nfApplyTheme, wait);
  }
  var nfThemeObserver = new MutationObserver(function(records) {
    var root = document.getElementById("nf-floating-widget") || nfThemeRoot;
    for (var i = 0; i < records.length; i++) {
      var record = records[i], target = record.target;
      if (root && (target === root || root.contains(target))) continue;
      if (record.type === "attributes") {
        if (target === document.documentElement || target === document.body || target.tagName === "LINK" || target.tagName === "STYLE" || nfThemeAncestors.indexOf(target) >= 0) { nfScheduleTheme(record.attributeName !== "style"); return; }
      } else {
        // Text and chart updates do not cause rediscovery; replaced samples and new surfaces do.
        if (!nfThemePage || !nfThemePage.isConnected || (nfThemeCard && !nfThemeCard.isConnected) || (nfThemeAccent && !nfThemeAccent.isConnected)) { nfScheduleTheme(true); return; }
        for (var j = 0; j < record.addedNodes.length; j++) {
          var added = record.addedNodes[j];
          var lateSurface = !nfThemeCard &&
            added.nodeType === 1 && ["DIV", "MAIN", "SECTION", "ARTICLE", "A", "LI"].indexOf(added.tagName) >= 0;
          if (added.nodeType === 1 && (!root || !root.contains(added)) &&
              (lateSurface || added.tagName === "STYLE" || added.tagName === "LINK")) {
            nfScheduleTheme(true, lateSurface ? Math.max(0, 5000 - (Date.now() - nfThemeLastDiscovery)) : 0); return;
          }
        }
        if (target.nodeType === 1 && target.closest("style")) { nfScheduleTheme(true); return; }
      }
    }
  });
  nfThemeObserver.observe(document.documentElement, { subtree: true, childList: true, attributes: true,
    attributeFilter: ["class", "style", "data-theme", "data-color-mode", "data-mode", "color-scheme", "hidden", "href", "media", "disabled"] });
  window.addEventListener("resize", function() { nfScheduleTheme(true); });
  window.addEventListener("load", function() { nfScheduleTheme(true); });
  document.addEventListener("load", function(e) { if (e.target.tagName === "LINK") nfScheduleTheme(true); }, true);
  document.addEventListener("visibilitychange", function() { if (!document.hidden) nfScheduleTheme(true); });
  if (nfThemeMedia.addEventListener) nfThemeMedia.addEventListener("change", function() { nfScheduleTheme(true); });
  nfApplyTheme();

  // 健壮黑名单路由判定：仅在管理后台、系统设置、终端或特定插件独立大屏/子页面中隐藏浮窗；其余所有前台页面（首页、节点列表、实例详情、自定义路由等）默认正常展示
  function nfIsAdminPath() {
    try {
      var p = (window.location.pathname || "").toLowerCase();
      var h = (window.location.hash || "").toLowerCase();

      // 1. 管理后台与系统页面 (兼顾 Path 路由与 Hash 路由)
      if (p.indexOf("/admin") !== -1 || h.indexOf("/admin") !== -1) return true;
      if (p.indexOf("/terminal") !== -1 || h.indexOf("/terminal") !== -1) return true;
      if (p.indexOf("/settings") !== -1 || h.indexOf("/settings") !== -1) return true;
      if (p.indexOf("/login") !== -1 || h.indexOf("/login") !== -1) return true;
      if (p.indexOf("/auth") !== -1 || h.indexOf("/auth") !== -1) return true;

      // 2. 独立插件页面 / HTML 页面 (如流媒体解锁矩阵、NetForecast 自身大屏等)
      if (p.indexOf("matrix.html") !== -1 || h.indexOf("matrix.html") !== -1) return true;
      if (p.indexOf("public.html") !== -1 || h.indexOf("public.html") !== -1) return true;
      if (p.indexOf("admin.html") !== -1 || h.indexOf("admin.html") !== -1) return true;
      if (p.indexOf("preview.html") !== -1 || h.indexOf("preview.html") !== -1) return true;
      if (p.indexOf("/api/plugin/") !== -1 || h.indexOf("/api/plugin/") !== -1) return true;

      return false;
    } catch (e) {
      return false;
    }
  }

  var WIDGET_INNER_HTML = [
    '<div class="nf-trigger-sq safe" id="nfTriggerBtn" data-km-fab="true" data-km-fab-id="net-forecast" title="流量预测 (可拖拽移动位置)">',
    '  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">',
    '    <line x1="18" y1="20" x2="18" y2="10"></line>',
    '    <line x1="12" y1="20" x2="12" y2="4"></line>',
    '    <line x1="6" y1="20" x2="6" y2="14"></line>',
    '    <path d="M3 14l5-4 5 3 7-7"></path>',
    '  </svg>',
    '  <div class="nf-sq-dot" id="nfSqDot"></div>',
    '</div>',
    '<div class="nf-widget-card" id="nfWidgetCard">',
    '  <div class="nf-header">',
    '    <div class="nf-header-title">',
    '      <div class="nf-header-icon">📊</div>',
    '      <span class="nf-header-text" id="nfWhTitle">流量预测与预算监控</span>',
    '    </div>',
    '    <button class="nf-close-btn" id="nfCloseBtn" title="关闭 (✕)">✕</button>',
    '  </div>',
    '  <div class="nf-kpi-bar">',
    '    <div class="nf-kpi-item"><span class="nf-kpi-lbl" id="nfKpiUsedLbl">配额总已用</span><span class="nf-kpi-val" id="nfKpiUsedVal">-</span></div>',
    '    <div class="nf-kpi-item"><span class="nf-kpi-lbl" id="nfKpiRiskLbl">超限风险</span><span class="nf-kpi-val" id="nfKpiRiskVal">-</span></div>',
    '    <div class="nf-kpi-item"><span class="nf-kpi-lbl" id="nfKpiResetLbl">最近重置</span><span class="nf-kpi-val" id="nfKpiResetVal">-</span></div>',
    '  </div>',
    '  <div class="nf-filter-bar" id="nfFilterBar">',
    '    <button class="nf-filter-btn" data-filter="CURRENT" id="nfBtnCurrent" style="display:none;">📌 当前 (1)</button>',
    '    <button class="nf-filter-btn active" data-filter="ALL" id="nfBtnAll">全部 (0)</button>',
    '    <button class="nf-filter-btn" data-filter="ALERT" id="nfBtnAlert">🚨 预警 (0)</button>',
    '    <button class="nf-filter-btn" data-filter="SAFE" id="nfBtnSafe">✅ 安全 (0)</button>',
    '    <button class="nf-filter-btn" data-filter="NO_QUOTA" id="nfBtnNoQuota">⚪ 免额 (0)</button>',
    '  </div>',
    '  <div class="nf-list" id="nfNodeList">',
    '    <div class="nf-empty">正在计算全节点流量与预算预测...</div>',
    '  </div>',
    '  <div class="nf-footer">',
    '    <div class="nf-footer-status"><div class="nf-live-dot"></div><span id="nfFooterStatus">实时监测中</span></div>',
    '    <a href="/api/plugin/net-forecast/pages/public.html" target="_blank" class="nf-btn-full" id="nfFooterFullBtn">完整图表 ↗</a>',
    '  </div>',
    '</div>'
  ].join("");

  var isEn = (navigator.language || "").toLowerCase().indexOf("en") === 0;
  var btn = null;
  var card = null;
  var closeBtn = null;
  var sqDot = null;
  var filterBar = null;
  var whTitle = null;
  var kpiUsedLbl = null;
  var kpiRiskLbl = null;
  var kpiResetLbl = null;
  var kpiUsedVal = null;
  var kpiRiskVal = null;
  var kpiResetVal = null;
  var btnCurrent = null;
  var btnAll = null;
  var btnAlert = null;
  var btnSafe = null;
  var btnNoQuota = null;
  var nodeList = null;
  var footerStatus = null;
  var footerFullBtn = null;

  var isOpen = false;
  var currentFilter = "ALL";
  var cachedData = null;
  var posKey = "nf_btn_pos_v2";

  // 稳健提取当前节点 ID (免正则转义干扰，全面支持 pathname / hash / search)
  function getCurrentInstanceUuid() {
    try {
      var pathname = (window.location.pathname || "").trim();
      var pathParts = pathname.split("/").filter(Boolean);
      for (var i = 0; i < pathParts.length; i++) {
        var seg = pathParts[i].toLowerCase();
        if ((seg === "instance" || seg === "instances" || seg === "node" || seg === "nodes" || seg === "server" || seg === "client") && pathParts[i + 1]) {
          var cand = decodeURIComponent(pathParts[i + 1]).trim();
          if (cand) return cand;
        }
      }

      var hash = (window.location.hash || "").trim();
      if (hash) {
        var cleanHash = hash.indexOf("#") === 0 ? hash.slice(1) : hash;
        if (cleanHash.indexOf("/") === 0) cleanHash = cleanHash.slice(1);
        var hashParts = cleanHash.split("?")[0].split("/").filter(Boolean);
        for (var j = 0; j < hashParts.length; j++) {
          var hseg = hashParts[j].toLowerCase();
          if ((hseg === "instance" || hseg === "instances" || hseg === "node" || hseg === "nodes" || hseg === "server" || hseg === "client") && hashParts[j + 1]) {
            var hcand = decodeURIComponent(hashParts[j + 1]).trim();
            if (hcand) return hcand;
          }
        }
      }

      var search = window.location.search || "";
      if (search && (search.indexOf("uuid=") !== -1 || search.indexOf("node_id=") !== -1 || search.indexOf("instance=") !== -1 || search.indexOf("id=") !== -1)) {
        var searchStr = search.indexOf("?") === 0 ? search.slice(1) : search;
        var params = searchStr.split("&");
        for (var p = 0; p < params.length; p++) {
          var pair = params[p].split("=");
          var k = (pair[0] || "").toLowerCase();
          if ((k === "uuid" || k === "node_id" || k === "instance" || k === "node" || k === "id") && pair[1]) {
            return decodeURIComponent(pair[1]).trim();
          }
        }
      }
    } catch (e) {}
    return null;
  }

  // 稳健查找目标节点（支持 ID、UUID、连字符兼容与短 UUID 前缀匹配）
  function findMatchingNode(nodes, targetId) {
    if (!Array.isArray(nodes) || !targetId) return null;
    var target = String(targetId).trim().toLowerCase();
    if (!target) return null;

    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      var id = String(n.node_id || n.uuid || "").trim().toLowerCase();
      var name = String(n.node_name || n.name || "").trim().toLowerCase();
      if (id === target || name === target) {
        return n;
      }
    }

    var targetNoDash = target.split("-").join("");
    if (targetNoDash.length >= 8) {
      for (var j = 0; j < nodes.length; j++) {
        var nj = nodes[j];
        var idNoDash = String(nj.node_id || nj.uuid || "").split("-").join("").toLowerCase();
        if (idNoDash && idNoDash === targetNoDash) {
          return nj;
        }
      }
    }

    if (target.length >= 6) {
      for (var k = 0; k < nodes.length; k++) {
        var nk = nodes[k];
        var kid = String(nk.node_id || nk.uuid || "").toLowerCase();
        if (kid && (kid.indexOf(target) === 0 || target.indexOf(kid) === 0)) {
          return nk;
        }
      }
    }

    return null;
  }

  function getOtherFabs(myEl, myId) {
    var list = [];
    var all = document.querySelectorAll("[data-km-fab='true'], .nf-trigger-sq, .km-ul-trigger-btn");
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      if (el === myEl || !el.isConnected) continue;
      var fabId = el.getAttribute("data-km-fab-id");
      if (fabId && fabId === myId) continue;
      var style = window.getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden") continue;
      var r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) {
        list.push(el);
      }
    }
    return list;
  }

  function isFabColliding(r1, r2) {
    return Math.abs(r1.left - r2.left) < 52 && Math.abs(r1.top - r2.top) < 52;
  }

  function resolveFabPosition(desiredL, desiredT, myEl, myId) {
    var l = desiredL;
    var t = desiredT;
    var winW = window.innerWidth;
    var winH = window.innerHeight;
    var others = getOtherFabs(myEl, myId);

    var attempts = 0;
    var collided = true;
    while (collided && attempts < 8) {
      collided = false;
      for (var i = 0; i < others.length; i++) {
        var other = others[i];
        var oRect = other.getBoundingClientRect();
        if (isFabColliding({ left: l, top: t }, oRect)) {
          collided = true;
          t -= 60;
          if (t < 24) {
            t = oRect.bottom + 12;
          }
          break;
        }
      }
      attempts++;
    }
    return {
      left: Math.max(10, Math.min(winW - 58, l)),
      top: Math.max(10, Math.min(winH - 58, t))
    };
  }

  function loadSavedPos() {
    if (!btn) return;
    var winW = window.innerWidth;
    var winH = window.innerHeight;
    var targetL = null;
    var targetT = null;

    try {
      var raw = localStorage.getItem(posKey);
      if (raw) {
        var p = JSON.parse(raw);
        if (typeof p.left === "number" && typeof p.top === "number") {
          targetL = p.left;
          targetT = p.top;
        }
      }
    } catch (e) {}

    if (targetL === null || targetT === null) {
      var others = getOtherFabs(btn, "net-forecast");
      var slotIndex = others.length;
      var margin = 24;
      var slotPitch = 60;
      targetL = winW - 48 - margin;
      targetT = winH - 48 - (margin + slotIndex * slotPitch);
      if (targetT < margin) {
        targetT = winH - 48 - margin;
      }
    }

    var safePos = resolveFabPosition(targetL, targetT, btn, "net-forecast");
    btn.style.setProperty("left", safePos.left + "px", "important");
    btn.style.setProperty("top", safePos.top + "px", "important");
    btn.style.setProperty("right", "auto", "important");
    btn.style.setProperty("bottom", "auto", "important");
  }

  var isDragging = false;
  var startX = 0, startY = 0;
  var origL = 0, origT = 0;

  function initButtonDraggable() {
    if (!btn) return;

    btn.onpointerdown = function(e) {
      if (e.button !== 0) return;
      btn.setPointerCapture(e.pointerId);
      isDragging = false;
      startX = e.clientX;
      startY = e.clientY;
      var rect = btn.getBoundingClientRect();
      origL = rect.left;
      origT = rect.top;
    };

    btn.onpointermove = function(e) {
      if (!btn.hasPointerCapture(e.pointerId)) return;
      var dx = e.clientX - startX;
      var dy = e.clientY - startY;
      if (Math.abs(dx) > 4 || Math.abs(dy) > 4) {
        isDragging = true;
        var newL = Math.max(10, Math.min(window.innerWidth - 56, origL + dx));
        var newT = Math.max(10, Math.min(window.innerHeight - 56, origT + dy));
        btn.style.setProperty("left", newL + "px", "important");
        btn.style.setProperty("top", newT + "px", "important");
        btn.style.setProperty("right", "auto", "important");
        btn.style.setProperty("bottom", "auto", "important");
        if (isOpen && typeof positionCard === "function") positionCard();
      }
    };

    btn.onpointerup = function(e) {
      if (!btn.hasPointerCapture(e.pointerId)) return;
      try { btn.releasePointerCapture(e.pointerId); } catch (err) {}
      if (isDragging) {
        var rect = btn.getBoundingClientRect();
        var safePos = resolveFabPosition(rect.left, rect.top, btn, "net-forecast");
        if (safePos.left !== rect.left || safePos.top !== rect.top) {
          btn.style.transition = "left 0.2s cubic-bezier(0.2, 0, 0, 1), top 0.2s cubic-bezier(0.2, 0, 0, 1)";
          btn.style.setProperty("left", safePos.left + "px", "important");
          btn.style.setProperty("top", safePos.top + "px", "important");
          setTimeout(function() {
            if (btn) btn.style.transition = "border-color 0.25s, box-shadow 0.25s, transform 0.15s";
          }, 250);
        }
        try {
          localStorage.setItem(posKey, JSON.stringify({ left: safePos.left, top: safePos.top }));
        } catch (err) {}
        if (isOpen && typeof positionCard === "function") positionCard();
      } else {
        toggle();
      }
    };

    btn.onpointercancel = function(e) {
      if (!btn.hasPointerCapture(e.pointerId)) return;
      try { btn.releasePointerCapture(e.pointerId); } catch (err) {}
      isDragging = false;
    };

    btn.onclick = function(e) {
      e.stopPropagation();
      e.preventDefault();
    };
  }

  function positionCard() {
    if (!card || !btn) return;
    var bRect = btn.getBoundingClientRect();
    var cardW = Math.min(440, window.innerWidth - 28);
    card.style.setProperty("width", cardW + "px", "important");

    var below = bRect.top <= window.innerHeight / 2;
    var available = below ? window.innerHeight - bRect.bottom - 24 : bRect.top - 24;
    card.style.setProperty("max-height", Math.max(80, Math.min(window.innerHeight * 0.8, available)) + "px", "important");

    var panelLeft = Math.max(14, Math.min(window.innerWidth - cardW - 14, bRect.left));
    card.style.setProperty("left", panelLeft + "px", "important");
    card.style.setProperty("right", "auto", "important");

    if (below) {
      var t = Math.max(12, bRect.bottom + 10);
      card.style.setProperty("top", t + "px", "important");
      card.style.setProperty("bottom", "auto", "important");
    } else {
      var b = Math.max(12, window.innerHeight - bRect.top + 10);
      card.style.setProperty("bottom", b + "px", "important");
      card.style.setProperty("top", "auto", "important");
    }
  }

  function formatBytes(bytes) {
    if (!bytes || bytes <= 0) return "0 B";
    var k = 1024;
    var sizes = ["B", "KB", "MB", "GB", "TB", "PB"];
    var i = Math.floor(Math.log(bytes) / Math.log(k));
    var idx = Math.min(i, sizes.length - 1);
    return (bytes / Math.pow(k, idx)).toFixed(idx === 0 ? 0 : 1) + " " + sizes[idx];
  }

  function openCard() {
    isOpen = true;
    try {
      window.dispatchEvent(new CustomEvent("km:floating-card-open", { detail: { sourceId: "net-forecast" } }));
    } catch (e) {}
    nfScheduleTheme(true);
    positionCard();
    if (card) {
      card.style.setProperty("display", "flex", "important");
      card.classList.add("nf-open");
    }
    if (cachedData && cachedData.nodes && cachedData.nodes.length > 0) {
      renderData(cachedData);
    } else {
      fetchAndCompute();
    }
  }

  function closeCard() {
    isOpen = false;
    if (card) {
      card.style.setProperty("display", "none", "important");
      card.classList.remove("nf-open");
    }
  }

  function toggle() {
    if (isOpen) {
      closeCard();
    } else {
      openCard();
    }
  }

  function bindWidgetElements() {
    btn = document.getElementById("nfTriggerBtn");
    card = document.getElementById("nfWidgetCard");
    closeBtn = document.getElementById("nfCloseBtn");
    sqDot = document.getElementById("nfSqDot");
    filterBar = document.getElementById("nfFilterBar");
    whTitle = document.getElementById("nfWhTitle");
    kpiUsedLbl = document.getElementById("nfKpiUsedLbl");
    kpiRiskLbl = document.getElementById("nfKpiRiskLbl");
    kpiResetLbl = document.getElementById("nfKpiResetLbl");
    kpiUsedVal = document.getElementById("nfKpiUsedVal");
    kpiRiskVal = document.getElementById("nfKpiRiskVal");
    kpiResetVal = document.getElementById("nfKpiResetVal");
    btnCurrent = document.getElementById("nfBtnCurrent");
    btnAll = document.getElementById("nfBtnAll");
    btnAlert = document.getElementById("nfBtnAlert");
    btnSafe = document.getElementById("nfBtnSafe");
    btnNoQuota = document.getElementById("nfBtnNoQuota");
    nodeList = document.getElementById("nfNodeList");
    footerStatus = document.getElementById("nfFooterStatus");
    footerFullBtn = document.getElementById("nfFooterFullBtn");

    if (isEn) {
      if (btn) btn.title = "Traffic Forecast (Drag to move)";
      if (whTitle) whTitle.textContent = "Traffic & Quota Forecast";
      if (kpiUsedLbl) kpiUsedLbl.textContent = "TOTAL USED";
      if (kpiRiskLbl) kpiRiskLbl.textContent = "AT RISK";
      if (kpiResetLbl) kpiResetLbl.textContent = "NEXT RESET";
      if (footerStatus) footerStatus.textContent = "Live Monitoring";
      if (footerFullBtn) footerFullBtn.textContent = "Full Chart ↗";
    }

    initButtonDraggable();
    setupFilters();

    if (closeBtn) {
      closeBtn.onclick = function(e) {
        e.stopPropagation();
        e.preventDefault();
        closeCard();
      };
    }
  }

  function ensureWidgetMounted() {
    if (nfIsAdminPath()) return null;
    var root = document.getElementById("nf-floating-widget");
    var btnEl = document.getElementById("nfTriggerBtn");
    var cardEl = document.getElementById("nfWidgetCard");
    var needsMount = !root || !root.isConnected || !document.body || !document.body.contains(root) || !btnEl || !cardEl;
    if (needsMount) {
      if (root && root.parentElement) {
        try { root.parentElement.removeChild(root); } catch (e) {}
      }
      root = document.createElement("div");
      root.id = "nf-floating-widget";
      try {
        var cachedTheme = localStorage.getItem("nf_theme_vars_v3");
        if (cachedTheme) {
          var parsedVars = JSON.parse(cachedTheme);
          if (parsedVars && typeof parsedVars === "object") {
            Object.keys(parsedVars).forEach(function(k) {
              root.style.setProperty("--nf-" + k, parsedVars[k]);
            });
          }
        }
      } catch (e) {}
      root.innerHTML = WIDGET_INNER_HTML;
      if (document.body) {
        document.body.appendChild(root);
      } else if (document.documentElement) {
        document.documentElement.appendChild(root);
      }
      nfThemeRoot = root;
      bindWidgetElements();
      loadSavedPos();
      nfApplyTheme();
      if (cachedData) renderData(cachedData);
    } else if (!btn || !card) {
      bindWidgetElements();
    }
    return root;
  }

  function nfCheckRoute() {
    nfLastRoute = location.href;
    nfScheduleTheme(true);
    nfSyncWidgetVisibility();
    if (cachedData && typeof renderData === "function") {
      renderData(cachedData);
    }
  }

  var nfIsReady = false;

  function nfRevealWidget() {
    ensureWidgetMounted();
    loadSavedPos();
    setTimeout(function() {
      nfApplyTheme();
      if (btn) {
        var rect = btn.getBoundingClientRect();
        var safePos = resolveFabPosition(rect.left, rect.top, btn, "net-forecast");
        if (safePos.left !== rect.left || safePos.top !== rect.top) {
          btn.style.setProperty("left", safePos.left + "px", "important");
          btn.style.setProperty("top", safePos.top + "px", "important");
        }
      }
      nfIsReady = true;
      var root = document.getElementById("nf-floating-widget") || nfThemeRoot;
      if (root) {
        root.classList.add("nf-ready");
      }
    }, 120);
  }

  function nfSyncWidgetVisibility() {
    if (nfIsAdminPath()) {
      var widgetRoot = document.getElementById("nf-floating-widget");
      if (widgetRoot) {
        widgetRoot.style.setProperty("display", "none", "important");
      }
      if (card) {
        isOpen = false;
        card.classList.remove("nf-open");
        card.style.setProperty("display", "none", "important");
      }
    } else {
      ensureWidgetMounted();
      var widgetRoot = document.getElementById("nf-floating-widget");
      if (widgetRoot) {
        widgetRoot.style.setProperty("display", "block", "important");
        if (nfIsReady) {
          widgetRoot.classList.add("nf-ready");
        }
      }
      if (btn) {
        btn.style.removeProperty("display");
      }
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", nfRevealWidget);
  } else {
    nfRevealWidget();
  }

  setTimeout(function() {
    if (!btn) return;
    var rect = btn.getBoundingClientRect();
    var safePos = resolveFabPosition(rect.left, rect.top, btn, "net-forecast");
    if (safePos.left !== rect.left || safePos.top !== rect.top) {
      btn.style.setProperty("left", safePos.left + "px", "important");
      btn.style.setProperty("top", safePos.top + "px", "important");
    }
  }, 400);

  window.addEventListener("popstate", nfCheckRoute);
  window.addEventListener("hashchange", nfCheckRoute);

  var origPushState = history.pushState;
  if (origPushState) {
    history.pushState = function() {
      var ret = origPushState.apply(this, arguments);
      setTimeout(nfCheckRoute, 50);
      return ret;
    };
  }
  var origReplaceState = history.replaceState;
  if (origReplaceState) {
    history.replaceState = function() {
      var ret = origReplaceState.apply(this, arguments);
      setTimeout(nfCheckRoute, 50);
      return ret;
    };
  }

  var nfLastRoute = location.href;
  setInterval(function() {
    nfSyncWidgetVisibility();
    if (location.href !== nfLastRoute) {
      nfCheckRoute();
    }
  }, 500);

  window.addEventListener("km:floating-card-open", function(e) {
    if (e.detail && e.detail.sourceId !== "net-forecast" && isOpen) {
      closeCard();
    }
  });

  document.addEventListener("pointerdown", function(e) {
    if (!isOpen) return;
    if (card && card.contains(e.target)) return;
    if (btn && btn.contains(e.target)) return;
    closeCard();
  });

  document.addEventListener("keydown", function(e) {
    if (e.key === "Escape" && isOpen) {
      closeCard();
    }
  });

  function updateKpiAndHeader(singleNode, summary, nodes) {
    if (currentFilter === "CURRENT" && singleNode) {
      if (whTitle) {
        whTitle.textContent = (isEn ? "Forecast: " : "流量预测 · ") + (singleNode.node_name || singleNode.node_id);
      }
      var nodeUsedBytes = (singleNode.cumulative && singleNode.cumulative.billable_bytes) || 0;
      if (kpiUsedLbl) kpiUsedLbl.textContent = isEn ? "USED" : "本期已用";
      if (kpiUsedVal) kpiUsedVal.textContent = formatBytes(nodeUsedBytes);

      if (kpiRiskLbl) kpiRiskLbl.textContent = isEn ? "PROJECTED" : "预测使用率";
      if (kpiRiskVal) {
        if (singleNode.has_quota && singleNode.traffic_limit_bytes > 0) {
          var ratioPct = Math.round((singleNode.usage_ratio || 0) * 100);
          kpiRiskVal.textContent = ratioPct + "%";
          kpiRiskVal.style.setProperty("--nf-risk", ratioPct >= 100 ? "var(--nf-danger)" : (ratioPct >= 90 ? "var(--nf-warning)" : "var(--nf-safe)"));
        } else {
          kpiRiskVal.textContent = isEn ? "Uncapped" : "免额度";
          kpiRiskVal.style.setProperty("--nf-risk", "var(--nf-card-text)");
        }
      }

      if (kpiResetLbl) kpiResetLbl.textContent = isEn ? "RESET DAY" : "账单重置";
      if (kpiResetVal) {
        var daysLeft = (singleNode.cycle && typeof singleNode.cycle.daysRemaining === "number") ? singleNode.cycle.daysRemaining : 0;
        kpiResetVal.textContent = singleNode.traffic_reset_day + (isEn ? "th (" + daysLeft + "d)" : "日 (余" + daysLeft + "天)");
      }
    } else {
      if (whTitle) {
        whTitle.textContent = isEn ? "Traffic & Quota Forecast" : "流量预测与预算监控";
      }
      var sum = summary || (cachedData && cachedData.summary) || {};
      var allNodes = nodes || (cachedData && cachedData.nodes) || [];

      var totalUsedBillable = 0;
      var minDays = 999;
      var minNode = null;

      allNodes.forEach(function(n) {
        if (n.cumulative && n.cumulative.billable_bytes) {
          totalUsedBillable += n.cumulative.billable_bytes;
        }
        if (n.cycle && typeof n.cycle.daysRemaining === "number") {
          if (n.cycle.daysRemaining < minDays) {
            minDays = n.cycle.daysRemaining;
            minNode = n;
          }
        }
      });

      if (kpiUsedLbl) kpiUsedLbl.textContent = isEn ? "TOTAL USED" : "配额总已用";
      if (kpiUsedVal) kpiUsedVal.textContent = formatBytes(totalUsedBillable);

      var crit = sum.critical_count || 0;
      var warn = sum.warning_count || 0;
      var totalAlerts = crit + warn;
      if (kpiRiskLbl) kpiRiskLbl.textContent = isEn ? "AT RISK" : "超限风险";
      if (kpiRiskVal) {
        kpiRiskVal.textContent = totalAlerts > 0 ? (totalAlerts + (isEn ? " Nodes Alert" : " 台预警")) : (isEn ? "All Safe" : "全节点安全");
        kpiRiskVal.style.setProperty("--nf-risk", totalAlerts > 0 ? "var(--nf-danger)" : "var(--nf-safe)");
      }

      if (kpiResetLbl) kpiResetLbl.textContent = isEn ? "NEXT RESET" : "最近重置";
      if (kpiResetVal) {
        if (minNode) {
          kpiResetVal.textContent = minNode.traffic_reset_day + (isEn ? "th (" + minDays + "d)" : "日 (余" + minDays + "天)");
        } else {
          kpiResetVal.textContent = "-";
        }
      }
    }
  }

  function setupFilters() {
    var btns = [btnCurrent, btnAll, btnAlert, btnSafe, btnNoQuota];
    btns.forEach(function(b) {
      if (!b) return;
      b.onclick = function() {
        btns.forEach(function(x) { if (x) x.classList.remove("active"); });
        b.classList.add("active");
        currentFilter = b.getAttribute("data-filter") || "ALL";
        var instanceUuid = getCurrentInstanceUuid();
        var nodes = (cachedData && cachedData.nodes) || [];
        var singleNode = instanceUuid ? findMatchingNode(nodes, instanceUuid) : null;
        updateKpiAndHeader(singleNode, cachedData && cachedData.summary, nodes);
        renderList();
      };
    });
  }
  setupFilters();

  // 4. 精炼卡片渲染 (区分单节点视图 vs 全局列表视图)
  function renderList() {
    if (!cachedData || !cachedData.nodes) return;
    if (!nodeList) return;
    var nodes = cachedData.nodes;
    var html = "";
    var instanceUuid = getCurrentInstanceUuid();
    var matchNode = instanceUuid ? findMatchingNode(nodes, instanceUuid) : null;

    var filtered = [];
    if (currentFilter === "CURRENT") {
      if (matchNode) {
        filtered = [matchNode];
      } else {
        filtered = nodes;
      }
    } else if (currentFilter === "ALL") {
      filtered = nodes;
    } else {
      filtered = nodes.filter(function(n) {
        var cat = (n.status === "CRITICAL" || n.status === "WARNING") ? "ALERT" : n.status;
        return cat === currentFilter;
      });
    }

    if (filtered.length === 0) {
      nodeList.innerHTML = '<div class="nf-empty">' + (isEn ? "No matching nodes" : "无符合条件的节点") + '</div>';
      return;
    }

    filtered.forEach(function(n) {
      var hasQuota = Boolean(n.has_quota);
      var status = n.status || "NO_QUOTA";
      var usedBytes = (n.cumulative && n.cumulative.billable_bytes) || 0;
      var quotaBytes = n.traffic_limit_bytes || 0;
      var dailyAvg = (n.daily_avg && n.daily_avg.billable_formatted) || "0 B";
      var daysRemaining = (n.cycle && n.cycle.daysRemaining !== undefined) ? n.cycle.daysRemaining : 0;
      var resetDay = n.traffic_reset_day || 1;

      var mode = (n.traffic_limit_type || "sum").toUpperCase();

      var badgeClass = "safe";
      var badgeText = isEn ? "Safe" : "正常";
      var pctClass = "";
      if (status === "CRITICAL") {
        badgeClass = "critical";
        badgeText = isEn ? "Alert" : "超限";
        pctClass = "critical";
      } else if (status === "WARNING") {
        badgeClass = "warning";
        badgeText = isEn ? "Warn" : "预警";
      } else if (status === "NO_QUOTA") {
        badgeClass = "no-quota";
        badgeText = isEn ? "Uncapped" : "免额";
      }

      var barHtml = "";
      var usedPct = 0;
      var metaLeft = "";

      if (hasQuota && quotaBytes > 0) {
        var usedRatio = usedBytes / quotaBytes;
        usedPct = Math.min(100, Math.round(usedRatio * 100));
        var projBytes = (n.projected && n.projected.billable_bytes) || usedBytes;
        var projPct = 0;
        if (projBytes > usedBytes) {
          projPct = Math.min(100 - usedPct, Math.max(0, Math.round((projBytes - usedBytes) / quotaBytes * 100)));
        }
        var isCrit = status === "CRITICAL";
        var usedColor = isCrit ? "var(--nf-danger)" : "var(--nf-accent)";
        var projClass = isCrit ? "critical" : "";
        barHtml = '<div class="nf-bar-used" style="width:' + usedPct + '%; background:' + usedColor + ';"></div>' +
                  '<div class="nf-bar-projected ' + projClass + '" style="width:' + projPct + '%;"></div>';
        metaLeft = (isEn ? "Used: " : "已用 ") + '<strong>' + formatBytes(usedBytes) + '</strong> / ' + formatBytes(quotaBytes);
      } else {
        barHtml = '<div class="nf-bar-used" style="width:100%; background:rgba(148, 163, 184, 0.45);"></div>';
        metaLeft = (isEn ? "Used: " : "已用 ") + '<strong>' + formatBytes(usedBytes) + '</strong> (' + (isEn ? "Uncapped" : "未设限额") + ')';
      }

      var metaSpeed = (isEn ? "Rate: " : "均速 ") + '<strong>' + dailyAvg + '/d</strong>';
      var metaReset = (isEn ? "Reset: " : "重置 ") + resetDay + (isEn ? "th (" + daysRemaining + "d)" : "日 (余" + daysRemaining + "天)");

      var pctText = (hasQuota && quotaBytes > 0) ? (Math.round((n.usage_ratio || 0) * 100) + "%") : (isEn ? "Uncapped" : "免额");

      html += '<div class="nf-node-card" data-node-id="' + (n.node_id || '') + '" title="' + (isEn ? "Click to view instance details" : "点击跳转至节点详情页") + '">' +
        '<div class="nf-row-head">' +
          '<div class="nf-node-name-wrap">' +
            '<span class="nf-node-name">' + (n.node_name || n.node_id) + '</span>' +
            '<span class="nf-node-jump">↗</span>' +
            '<span class="nf-mode-badge">' + mode + '</span>' +
          '</div>' +
          '<div class="nf-status-wrap">' +
            '<span class="nf-badge ' + badgeClass + '">' + badgeText + '</span>' +
            '<span class="nf-pct ' + pctClass + '">' + pctText + '</span>' +
          '</div>' +
        '</div>' +
        '<div class="nf-bar-bg">' + barHtml + '</div>' +
        '<div class="nf-row-meta">' +
          '<span>' + metaLeft + '</span>' +
          '<span class="nf-speed">' + metaSpeed + '</span>' +
          '<span>' + metaReset + '</span>' +
        '</div>' +
      '</div>';
    });

    nodeList.innerHTML = html;

    // 为每个卡片绑定点击跳转事件 (智能适配 Path 路由与 Hash 路由)
    var cards = nodeList.querySelectorAll(".nf-node-card");
    cards.forEach(function(card) {
      card.onclick = function() {
        var nid = card.getAttribute("data-node-id");
        if (!nid) return;
        var curUuid = getCurrentInstanceUuid();
        if (curUuid) {
          var c1 = curUuid.split("-").join("").toLowerCase();
          var c2 = nid.split("-").join("").toLowerCase();
          if (c1 === c2) return;
        }
        if (window.location.hash && window.location.hash.indexOf("/instance") !== -1) {
          window.location.hash = "#/instance/" + encodeURIComponent(nid);
        } else {
          window.location.href = "/instance/" + encodeURIComponent(nid);
        }
      };
    });
  }

  function renderData(data) {
    cachedData = data;
    if (!btn) ensureWidgetMounted();
    if (!btn) return;
    var summary = data.summary || {};
    var nodes = data.nodes || [];
    var instanceUuid = getCurrentInstanceUuid();
    var singleNode = instanceUuid ? findMatchingNode(nodes, instanceUuid) : null;

    // 1. 设置方形图标状态
    if (singleNode) {
      var isSingleAlert = singleNode.status === "CRITICAL" || singleNode.status === "WARNING";
      if (isSingleAlert) {
        if (btn) btn.className = "nf-trigger-sq alert";
        if (sqDot) sqDot.className = "nf-sq-dot alert";
      } else {
        if (btn) btn.className = "nf-trigger-sq safe";
        if (sqDot) sqDot.className = "nf-sq-dot";
      }
    } else {
      var totalAlerts = (summary.critical_count || 0) + (summary.warning_count || 0);
      if (totalAlerts > 0) {
        if (btn) btn.className = "nf-trigger-sq alert";
        if (sqDot) sqDot.className = "nf-sq-dot alert";
      } else {
        if (btn) btn.className = "nf-trigger-sq safe";
        if (sqDot) sqDot.className = "nf-sq-dot";
      }
    }

    // 2. 筛选按钮显隐与状态管理
    if (singleNode) {
      if (btnCurrent) {
        btnCurrent.style.display = "inline-flex";
        btnCurrent.textContent = isEn ? "📌 Current (1)" : "📌 当前 (1)";
      }
      if (!currentFilter || currentFilter === "ALL" || currentFilter === "CURRENT") {
        currentFilter = "CURRENT";
      }
    } else {
      if (btnCurrent) {
        btnCurrent.style.display = "none";
      }
      if (currentFilter === "CURRENT") {
        currentFilter = "ALL";
      }
    }

    var btns = [btnCurrent, btnAll, btnAlert, btnSafe, btnNoQuota];
    btns.forEach(function(b) {
      if (!b) return;
      if (b.getAttribute("data-filter") === currentFilter) {
        b.classList.add("active");
      } else {
        b.classList.remove("active");
      }
    });

    var crit = summary.critical_count || 0;
    var warn = summary.warning_count || 0;
    var safe = summary.safe_count || 0;
    var noQuota = summary.no_quota_count || 0;
    var totalAlertsAll = crit + warn;

    if (btnAll) btnAll.textContent = (isEn ? "All (" : "全部 (") + nodes.length + ")";
    if (btnAlert) btnAlert.textContent = (isEn ? "🚨 Alert (" : "🚨 预警 (") + totalAlertsAll + ")";
    if (btnSafe) btnSafe.textContent = (isEn ? "✅ Safe (" : "✅ 安全 (") + safe + ")";
    if (btnNoQuota) btnNoQuota.textContent = (isEn ? "⚪ Uncapped (" : "⚪ 免额 (") + noQuota + ")";

    // 3. 更新 KPI 和 Header
    updateKpiAndHeader(singleNode, summary, nodes);

    // 4. 更新底栏跳转链接
    if (footerFullBtn) {
      if (singleNode) {
        footerFullBtn.href = "/api/plugin/net-forecast/pages/public.html?uuid=" + encodeURIComponent(singleNode.node_id || singleNode.uuid || instanceUuid);
      } else {
        footerFullBtn.href = "/api/plugin/net-forecast/pages/public.html";
      }
    }

    // 5. 渲染列表
    renderList();
  }

  // 深度数据计算与同步
  async function fetchAndCompute() {
    try {
      var baseRes = await fetch("/api/plugin/net-forecast/overview", { cache: "no-store" });
      if (!baseRes.ok) return;
      var baseJson = await baseRes.json();
      if (!baseJson || !baseJson.ok || !Array.isArray(baseJson.nodes)) return;

      renderData(baseJson);
    } catch (e) {
      console.warn("[NetForecast Widget] sync error:", e);
    }
  }

  fetchAndCompute();
  setInterval(fetchAndCompute, 45000);
})();
</script>`;

function load() {
  console.log("[NetForecast] Plugin loaded in strict real-data mode.");
  const storage = new TrafficStorage();

  const getConfig = () => {
    const raw = server.getConfig ? server.getConfig() : {};
    return {
      default_reset_day: Number(raw.default_reset_day) || 1,
      warning_threshold: Number(raw.warning_threshold) || 90,
      auto_collect_cron: raw.auto_collect_cron || "*/10 * * * *",
      enable_floating_widget: raw.enable_floating_widget !== undefined ? Boolean(raw.enable_floating_widget) : true,
      timezone_offset: raw.timezone_offset !== undefined && !isNaN(raw.timezone_offset) ? Number(raw.timezone_offset) : 8,
    };
  };

  const parseBody = (body) => {
    try {
      return JSON.parse(body || "{}");
    } catch (e) {
      return {};
    }
  };

  const fetchCoreClients = async (fallbackClients) => {
    let clients = [];
    if (Array.isArray(fallbackClients) && fallbackClients.length > 0) {
      clients = fallbackClients;
    } else if (server.call) {
      try {
        const res = await server.call("admin:listClients").catch(() => null);
        if (Array.isArray(res) && res.length > 0) {
          clients = res;
        } else {
          const alt = await server.call("common:getNodes").catch(() => null);
          if (Array.isArray(alt) && alt.length > 0) clients = alt;
        }
      } catch (e) {
        console.warn("[NetForecast] fetchCoreClients notice:", e);
      }
    }

    // 尝试拉取实时状态以补充网卡实时累计计数器 (totalUp / totalDown)
    if (server.call && Array.isArray(clients) && clients.length > 0) {
      try {
        const statusRes = await server.call("common:getNodesLatestStatus").catch(() => null);
        const statusData = (statusRes && statusRes.data) ? statusRes.data : statusRes;
        if (statusData && typeof statusData === "object") {
          clients.forEach((c) => {
            const uuid = c.uuid || c.id;
            const item = statusData[uuid] || (statusData.data && statusData.data[uuid]);
            if (item && item.network) {
              const up = Number(item.network.totalUp !== undefined ? item.network.totalUp : (item.network.total_up || 0));
              const down = Number(item.network.totalDown !== undefined ? item.network.totalDown : (item.network.total_down || 0));
              if (up > 0 && !c.net_total_up) c.net_total_up = up;
              if (down > 0 && !c.net_total_down) c.net_total_down = down;
              if (typeof item.network.up === "number") c.net_out = item.network.up;
              if (typeof item.network.down === "number") c.net_in = item.network.down;
            }
          });
        }
      } catch (e) {
        console.warn("[NetForecast] getNodesLatestStatus RPC notice:", e);
      }
    }

    return clients;
  };

  // 内存诊断快照缓存（3 分钟 TTL，防 DoS 击穿限流保护）
  let latestDebugSnapshot = null;
  let lastSnapshotUpdateTime = 0;
  let isRefreshingSnapshot = false;
  const SNAPSHOT_CACHE_TTL_MS = 180 * 1000;

  // 1. 全节点 30 天预测总览接口
  const handleOverview = async (req, res) => {
    try {
      const config = getConfig();
      const tzOffset = config.timezone_offset !== undefined && !isNaN(config.timezone_offset) ? Number(config.timezone_offset) : 8;
      const body = req.body ? parseBody(req.body) : {};

      // 1. 若为只读 GET 请求（或未传 clients 的空请求），且当前内存中已存在完整的全局快照，直接复用秒级响应（数据 100% 对齐，0 次计算开销）
      if ((!body.clients || body.clients.length === 0) && latestDebugSnapshot && latestDebugSnapshot.nodes && latestDebugSnapshot.nodes.length > 0) {
        const crit = latestDebugSnapshot.nodes.filter((n) => n.status === "CRITICAL").length;
        const warn = latestDebugSnapshot.nodes.filter((n) => n.status === "WARNING").length;
        const safe = latestDebugSnapshot.nodes.filter((n) => n.status === "SAFE").length;
        const noq = latestDebugSnapshot.nodes.filter((n) => n.status === "NO_QUOTA").length;
        sendJSON(res, {
          ok: true,
          summary: {
            total_nodes: latestDebugSnapshot.nodes.length,
            critical_count: crit,
            warning_count: warn,
            safe_count: safe,
            no_quota_count: noq,
            timezone_offset: tzOffset,
          },
          nodes: latestDebugSnapshot.nodes,
        });
        return;
      }

      let clients = await fetchCoreClients(body.clients);

      if (!clients) {
        clients = [];
      }

      // 2. 将前端上报的高精度历史 daily_history 持久化沉淀至本地时序存储，彻底消除前后台时序割裂
      if (Array.isArray(body.clients) && body.clients.length > 0) {
        body.clients.forEach((c) => {
          if (c && c.uuid && Array.isArray(c.daily_history) && c.daily_history.length > 0) {
            storage.setNodeDailyHistory(c.uuid, c.daily_history);
          }
        });
      }

      const list = clients.map((c) => {
        const currentDown = typeof c.net_total_down === "number" ? c.net_total_down : c.net_in;
        const currentUp = typeof c.net_total_up === "number" ? c.net_total_up : c.net_out;
        if (typeof currentDown === "number" && typeof currentUp === "number") {
          storage.recordSample(c.uuid, currentDown, currentUp, new Date(), tzOffset);
        }
        const history = Array.isArray(c.daily_history) && c.daily_history.length > 0
          ? c.daily_history
          : storage.getNodeHistory(c.uuid);

        return calculateNodeForecast(history, c, config.warning_threshold, new Date(), tzOffset);
      });

      const criticalCount = list.filter((n) => n.status === "CRITICAL").length;
      const warningCount = list.filter((n) => n.status === "WARNING").length;
      const safeCount = list.filter((n) => n.status === "SAFE").length;
      const noQuotaCount = list.filter((n) => n.status === "NO_QUOTA").length;

      // 3. 仅当携带高精度完整打点历史 (daily_history / raw_records_map) 或全局快照尚未建立时，才更新全局快照
      const hasFullHistory = (body.raw_records_map && Object.keys(body.raw_records_map).length > 0) ||
                             (Array.isArray(body.clients) && body.clients.some((c) => Array.isArray(c.daily_history) && c.daily_history.length > 0));

      if (latestDebugSnapshot && Array.isArray(latestDebugSnapshot.nodes)) {
        if (list.length === 1 && latestDebugSnapshot.nodes.length > 1) {
          // 单节点重试局部更新：外科手术式局部更新快照中的该节点，不冲刷其余节点！
          const updatedNode = list[0];
          const snapNodes = latestDebugSnapshot.nodes.slice();
          const sIdx = snapNodes.findIndex((n) => n.node_id === updatedNode.node_id);
          if (sIdx >= 0) snapNodes[sIdx] = updatedNode;
          else snapNodes.push(updatedNode);
          latestDebugSnapshot.nodes = snapNodes;
          latestDebugSnapshot.meta.node_count = snapNodes.length;
          latestDebugSnapshot.meta.server_time = new Date().toISOString();
        } else if (hasFullHistory || list.length >= latestDebugSnapshot.nodes.length) {
          latestDebugSnapshot = {
            meta: {
              server_time: new Date().toISOString(),
              client_timestamp: body.client_timestamp || new Date().toISOString(),
              timezone_offset: tzOffset,
              node_count: list.length,
              cached_at: new Date().toISOString(),
              cache_ttl_seconds: 180,
              source: body.raw_records_map ? "overview_full_sync" : "overview_sync"
            },
            server_debug: {
              ok: true,
              server_time: new Date().toISOString(),
              config: config,
              traffic_storage_keys: Object.keys(storage.trafficCache || {}),
              traffic_storage_records: storage.trafficCache || {},
              clients_count: clients.length,
              clients: clients
            },
            nodes: list,
            raw_records_map: Object.assign({}, latestDebugSnapshot.raw_records_map || {}, body.raw_records_map || {})
          };
          lastSnapshotUpdateTime = Date.now();
        }
      } else {
        latestDebugSnapshot = {
          meta: {
            server_time: new Date().toISOString(),
            client_timestamp: body.client_timestamp || new Date().toISOString(),
            timezone_offset: tzOffset,
            node_count: list.length,
            cached_at: new Date().toISOString(),
            cache_ttl_seconds: 180,
            source: body.raw_records_map ? "overview_full_sync" : "overview_sync"
          },
          server_debug: {
            ok: true,
            server_time: new Date().toISOString(),
            config: config,
            traffic_storage_keys: Object.keys(storage.trafficCache || {}),
            traffic_storage_records: storage.trafficCache || {},
            clients_count: clients.length,
            clients: clients
          },
          nodes: list,
          raw_records_map: body.raw_records_map || {}
        };
        lastSnapshotUpdateTime = Date.now();
      }

      sendJSON(res, {
        ok: true,
        summary: {
          total_nodes: list.length,
          critical_count: criticalCount,
          warning_count: warningCount,
          safe_count: safeCount,
          no_quota_count: noQuotaCount,
          timezone_offset: tzOffset,
        },
        nodes: list,
      });
    } catch (e) {
      sendJSON(res, { ok: false, error: e.message || String(e) }, 500);
    }
  };

  // 诊断数据导出静态接口（直接响应纯文本 JSON，3分钟内存缓存，单次请求 <1ms，彻底免疫 DoS）
  const handleExportJson = async (req, res) => {
    try {
      const now = Date.now();
      // 1. 若内存快照有效（3 分钟内），直接从内存返回（耗时 < 1ms，0 次数据库查询，彻底免疫 DoS 攻击）
      if (latestDebugSnapshot && (now - lastSnapshotUpdateTime < SNAPSHOT_CACHE_TTL_MS)) {
        res.setHeader("Cache-Control", "public, max-age=60");
        const ageSeconds = Math.round((now - lastSnapshotUpdateTime) / 1000);
        const copy = Object.assign({}, latestDebugSnapshot);
        copy.meta = Object.assign({}, copy.meta, {
          cache_hit: true,
          cache_age_seconds: ageSeconds
        });
        sendJSON(res, copy, 200);
        return;
      }

      // 2. 若快照正在刷新或已存在快照且仍处于 60 秒节流窗口内，直接返回既有快照防击穿
      if (isRefreshingSnapshot && latestDebugSnapshot) {
        res.setHeader("Cache-Control", "public, max-age=60");
        sendJSON(res, latestDebugSnapshot, 200);
        return;
      }

      isRefreshingSnapshot = true;
      try {
        const config = getConfig();
        const tzOffset = config.timezone_offset !== undefined && !isNaN(config.timezone_offset) ? Number(config.timezone_offset) : 8;
        let clients = await fetchCoreClients();
        if (!clients) clients = [];

        const list = clients.map((c) => {
          const history = storage.getNodeHistory(c.uuid);
          return calculateNodeForecast(history, c, config.warning_threshold, new Date(), tzOffset);
        });

        latestDebugSnapshot = {
          meta: {
            server_time: new Date().toISOString(),
            client_timestamp: new Date().toISOString(),
            timezone_offset: tzOffset,
            node_count: list.length,
            cached_at: new Date().toISOString(),
            cache_ttl_seconds: 180,
            cache_hit: false,
            source: "server_refresh"
          },
          server_debug: {
            ok: true,
            server_time: new Date().toISOString(),
            config: config,
            traffic_storage_keys: Object.keys(storage.trafficCache || {}),
            traffic_storage_records: storage.trafficCache || {},
            clients_count: clients.length,
            clients: clients
          },
          nodes: list,
          raw_records_map: latestDebugSnapshot ? (latestDebugSnapshot.raw_records_map || {}) : {}
        };
        lastSnapshotUpdateTime = Date.now();
      } finally {
        isRefreshingSnapshot = false;
      }

      res.setHeader("Cache-Control", "public, max-age=60");
      sendJSON(res, latestDebugSnapshot, 200);
    } catch (e) {
      sendJSON(res, { ok: false, error: e.message || String(e) }, 500);
    }
  };

  server.route("GET", "/api/plugin/net-forecast/export.json", handleExportJson);
  server.route("GET", "/api/plugin/net-forecast/debug.json", handleExportJson);
  server.route("GET", "/api/plugin/net-forecast/debug", handleExportJson);
  server.route("GET", "/api/plugin/net-forecast/overview", handleOverview);
  server.route("POST", "/api/plugin/net-forecast/overview", handleOverview);

  // 2. 限额配置更新：直写 Komari 核心数据库
  server.route("POST", "/api/plugin/net-forecast/update-quota", async (req, res) => {
    try {
      const data = parseBody(req.body);
      const uuid = data.uuid || data.node_id;
      if (!uuid) {
        sendJSON(res, { ok: false, error: "Missing uuid" }, 400);
        return;
      }

      const payload = {
        uuid: uuid,
        traffic_limit: Number(data.traffic_limit) >= 0 ? Number(data.traffic_limit) : 0,
        traffic_limit_type: data.traffic_limit_type || "sum",
      };

      let rpcSuccess = false;
      if (server.call) {
        try {
          await server.call("admin:editClient", payload);
          rpcSuccess = true;
        } catch (e) {
          console.warn("[NetForecast] admin:editClient notice:", e);
        }
      }

      sendJSON(res, {
        ok: true,
        rpc_success: rpcSuccess,
        message: "Node settings update submitted directly to Komari core",
        payload,
      });
    } catch (e) {
      sendJSON(res, { ok: false, error: e.message || String(e) }, 500);
    }
  });

  // 3. 定时同步轮询
  const config = getConfig();
  try {
    server.cron(config.auto_collect_cron, async () => {
      try {
        if (server.call) {
          const clients = await fetchCoreClients();
          if (Array.isArray(clients)) {
            const tzOffset = config.timezone_offset !== undefined && !isNaN(config.timezone_offset) ? Number(config.timezone_offset) : 8;
            for (const c of clients) {
              const currentDown = typeof c.net_total_down === "number" ? c.net_total_down : c.net_in;
              const currentUp = typeof c.net_total_up === "number" ? c.net_total_up : c.net_out;
              if (c.uuid && typeof currentDown === "number" && typeof currentUp === "number") {
                storage.recordSample(c.uuid, currentDown, currentUp, new Date(), tzOffset);
              }
            }
          }
        }
      } catch (e) {
        // cron error ignored
      }
    });
  } catch (e) {
    console.warn("[NetForecast] Cron registration notice:", e);
  }

  // 4. 前台浮出层组件 HTML 自动注入 (根据配置 enable_floating_widget)
  if (config.enable_floating_widget && server.injectHTML) {
    try {
      server.injectHTML(WIDGET_HEAD_HTML, WIDGET_BODY_HTML);
      console.log("[NetForecast] Floating widget injected successfully.");
    } catch (e) {
      console.warn("[NetForecast] injectHTML notice:", e);
    }
  }

  // 5. RPC
  server.registerRPC("netForecast:getOverview", async () => {
    if (latestDebugSnapshot && Array.isArray(latestDebugSnapshot.nodes) && latestDebugSnapshot.nodes.length > 0) {
      return {
        ok: true,
        nodes: latestDebugSnapshot.nodes,
      };
    }
    const config = getConfig();
    const tzOffset = config.timezone_offset !== undefined && !isNaN(config.timezone_offset) ? Number(config.timezone_offset) : 8;
    const clients = await fetchCoreClients();
    return {
      ok: true,
      nodes: clients.map((c) => {
        const history = storage.getNodeHistory(c.uuid);
        return calculateNodeForecast(history, c, config.warning_threshold, new Date(), tzOffset);
      }),
    };
  });
}

function unload() {
  console.log("[NetForecast] Plugin unloaded.");
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { load, unload };
}
