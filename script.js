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

function formatDateToYMD(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * 计算账单周期范围
 */
function calculateBillingCycle(resetDay = 1, now = new Date()) {
  const currentYear = now.getFullYear();
  const currentMonth = now.getMonth();
  const currentDate = now.getDate();

  const safeResetDay = Math.max(1, Math.min(31, Math.floor(Number(resetDay) || 1)));

  // 当前月的实际月末重置日（例如 4 月是 30，2 月是 28 或 29，防止设置 31 号的节点在小月末无法进入新周期）
  const maxDayThisMonth = getDaysInMonth(currentYear, currentMonth);
  const actualResetDayThisMonth = Math.min(safeResetDay, maxDayThisMonth);

  let cycleStartDate;
  let cycleEndDate;

  if (currentDate >= actualResetDayThisMonth) {
    cycleStartDate = new Date(currentYear, currentMonth, actualResetDayThisMonth, 0, 0, 0, 0);

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

    cycleEndDate = new Date(currentYear, currentMonth, actualResetDayThisMonth, 0, 0, 0, 0);
  }

  const oneDayMs = 24 * 60 * 60 * 1000;
  const daysTotal = Math.max(1, Math.round((cycleEndDate.getTime() - cycleStartDate.getTime()) / oneDayMs));
  const daysElapsed = Math.max(1, Math.min(daysTotal, Math.ceil((now.getTime() - cycleStartDate.getTime()) / oneDayMs)));
  const daysRemaining = Math.max(0, daysTotal - daysElapsed);

  return {
    cycleStart: formatDateToYMD(cycleStartDate),
    cycleEnd: formatDateToYMD(cycleEndDate),
    cycleStartDate,
    cycleEndDate,
    daysTotal,
    daysElapsed,
    daysRemaining,
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
function buildCycleSeries(history, mode, cycle, dailyAvgIn, dailyAvgOut, currentCycleBillable, cumulativeIn = 0, cumulativeOut = 0, now = new Date()) {
  const historyMap = {};
  (history || []).forEach((item) => {
    if (item.date) {
      historyMap[item.date] = item;
    }
  });

  const points = [];
  const cycleStart = cycle.cycleStartDate;
  const daysTotal = cycle.daysTotal;
  const todayStr = formatDateToYMD(now);
  const nowMs = now.getTime();

  let runningIn = 0;
  let runningOut = 0;
  let todayIndex = -1;

  for (let i = 0; i <= daysTotal; i++) {
    const d = new Date(cycleStart.getTime() + i * 24 * 3600 * 1000);
    const dateStr = formatDateToYMD(d);
    const isToday = (dateStr === todayStr);
    const isPast = (d.getTime() < nowMs) && !isToday;
    const isFuture = (d.getTime() > nowMs) && !isToday;

    if (isToday) {
      todayIndex = i;
    }

    const rec = historyMap[dateStr];

    if (isPast) {
      if (rec && ((rec.in_bytes || 0) + (rec.out_bytes || 0) > 0)) {
        runningIn += (rec.in_bytes || 0);
        runningOut += (rec.out_bytes || 0);
        const cumBillable = computeBillableAmount(runningIn, runningOut, mode);
        points.push({
          date: dateStr,
          timestamp: d.getTime(),
          has_data: true,
          in_bytes: rec.in_bytes || 0,
          out_bytes: rec.out_bytes || 0,
          total_bytes: (rec.in_bytes || 0) + (rec.out_bytes || 0),
          cumulative_bytes: runningIn + runningOut,
          cumulative_billable: cumBillable,
          is_today: false,
          is_forecast: false,
        });
      } else {
        // 过去无打点数据（如冷启动安装前）：绝不输出 0 贴地折线，cumulative_billable 为 null
        points.push({
          date: dateStr,
          timestamp: d.getTime(),
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
      points.push({
        date: dateStr,
        timestamp: d.getTime(),
        has_data: true,
        in_bytes: inB,
        out_bytes: outB,
        total_bytes: inB + outB,
        cumulative_bytes: cumulativeIn + cumulativeOut,
        cumulative_billable: currentCycleBillable,
        is_today: true,
        is_forecast: false,
      });
    } else {
      // 未来推算点：严格不画柱体 (in_bytes=0, out_bytes=0)，虚线平滑延伸至周期结束日
      const dailyForecastBillable = computeBillableAmount(dailyAvgIn, dailyAvgOut, mode);
      const futureStep = i - (todayIndex >= 0 ? todayIndex : cycle.daysElapsed);
      const fCumBillable = currentCycleBillable + dailyForecastBillable * Math.max(0, futureStep);

      points.push({
        date: dateStr,
        timestamp: d.getTime(),
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
function extractResetDayFromExpiredAt(expiredAt, fallbackResetDay = 1) {
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

      // 如果时间戳接近 UTC 零点，在西区使用 UTC 日期能更忠实还原配置日
      day = dateObj.getUTCDate();
      dateStr = dateObj.toISOString().split("T")[0];
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
function calculateNodeForecast(history, node, warningThresholdPercent = 90, now = new Date()) {
  const extracted = extractResetDayFromExpiredAt(node.expired_at, Number(node.traffic_reset_day) || 1);
  const resetDay = extracted.resetDay;
  const cycle = calculateBillingCycle(resetDay, now);
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

  let cumulativeIn = 0;
  let cumulativeOut = 0;

  if (rawTotalUp > 0 || rawTotalDown > 0) {
    cumulativeIn = rawTotalDown;
    cumulativeOut = rawTotalUp;
  } else {
    (history || []).forEach((r) => {
      if (r.timestamp >= cycleStartMs && r.timestamp <= now.getTime()) {
        cumulativeIn += r.in_bytes || 0;
        cumulativeOut += r.out_bytes || 0;
      }
    });
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

  const chartSeries = buildCycleSeries(history, mode, cycle, dailyAvgIn, dailyAvgOut, cumulativeBillable, cumulativeIn, cumulativeOut, now);

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

  recordSample(nodeId, currentIn, currentOut, now = new Date()) {
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

    const todayStr = now.toISOString().split("T")[0];
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

function sendJSON(res, data, statusCode = 200) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
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
}

#nf-floating-widget {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif !important;
  color: #f8fafc !important;
  z-index: 99999 !important;
}

/* 1. 可拖拽方形触发图标按钮 (无文字，边框状态变色) */
#nf-floating-widget .nf-trigger-sq {
  width: 48px !important;
  height: 48px !important;
  position: fixed !important;
  background: rgba(15, 23, 42, 0.92) !important;
  border-radius: 12px !important;
  backdrop-filter: blur(20px) !important;
  -webkit-backdrop-filter: blur(20px) !important;
  display: flex !important;
  align-items: center !important;
  justify-content: center !important;
  cursor: grab !important;
  user-select: none !important;
  touch-action: none !important;
  z-index: 99999 !important;
  transition: border-color 0.25s, box-shadow 0.25s, transform 0.15s !important;
}
#nf-floating-widget .nf-trigger-sq:active {
  cursor: grabbing !important;
  transform: scale(0.96) !important;
}
#nf-floating-widget .nf-trigger-sq * {
  pointer-events: none !important;
}
/* 无警告状态：绿色外框 */
#nf-floating-widget .nf-trigger-sq.safe {
  border: 2px solid #10b981 !important;
  color: #10b981 !important;
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.5), 0 0 14px rgba(16, 185, 129, 0.4) !important;
}
#nf-floating-widget .nf-trigger-sq.safe:hover {
  border-color: #34d399 !important;
  box-shadow: 0 8px 25px rgba(0, 0, 0, 0.6), 0 0 18px rgba(16, 185, 129, 0.6) !important;
}
/* 有警告状态：红色外框与脉冲 */
#nf-floating-widget .nf-trigger-sq.alert {
  border: 2px solid #ef4444 !important;
  color: #ef4444 !important;
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.5), 0 0 16px rgba(239, 68, 68, 0.55) !important;
  animation: nfSqPulse 1.8s infinite !important;
}
#nf-floating-widget .nf-trigger-sq.alert:hover {
  border-color: #f87171 !important;
  box-shadow: 0 8px 25px rgba(0, 0, 0, 0.6), 0 0 22px rgba(239, 68, 68, 0.75) !important;
}
@keyframes nfSqPulse {
  0% { box-shadow: 0 6px 20px rgba(0, 0, 0, 0.5), 0 0 12px rgba(239, 68, 68, 0.4); }
  50% { box-shadow: 0 6px 24px rgba(0, 0, 0, 0.6), 0 0 22px rgba(239, 68, 68, 0.8); }
  100% { box-shadow: 0 6px 20px rgba(0, 0, 0, 0.5), 0 0 12px rgba(239, 68, 68, 0.4); }
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
  box-shadow: 0 0 8px #ef4444 !important;
}

/* 2. 展开看板面板主体 (默认严格隐藏，仅带有 .nf-open 时以 flex 显现) */
#nf-floating-widget .nf-widget-card {
  display: none !important;
  position: fixed !important;
  z-index: 99998 !important;
  width: 440px !important;
  max-width: calc(100vw - 28px) !important;
  max-height: 80vh !important;
  background: rgba(15, 23, 42, 0.96) !important;
  border: 1px solid rgba(255, 255, 255, 0.12) !important;
  backdrop-filter: blur(28px) !important;
  -webkit-backdrop-filter: blur(28px) !important;
  border-radius: 20px !important;
  box-shadow: 0 24px 60px rgba(0, 0, 0, 0.8), 0 0 45px rgba(99, 102, 241, 0.18) !important;
  flex-direction: column !important;
  overflow: hidden !important;
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
  border-bottom: 1px solid rgba(255, 255, 255, 0.08) !important;
  display: flex !important;
  align-items: center !important;
  justify-content: space-between !important;
  background: rgba(30, 41, 59, 0.4) !important;
  flex-shrink: 0 !important;
}
#nf-floating-widget .nf-header-title {
  display: flex !important;
  align-items: center !important;
  gap: 10px !important;
  min-width: 0 !important;
}
#nf-floating-widget .nf-header-icon {
  font-size: 15px !important;
  background: rgba(99, 102, 241, 0.22) !important;
  width: 30px !important;
  height: 30px !important;
  display: flex !important;
  align-items: center !important;
  justify-content: center !important;
  border-radius: 8px !important;
  border: 1px solid rgba(99, 102, 241, 0.4) !important;
  flex-shrink: 0 !important;
}
#nf-floating-widget .nf-header-text {
  font-size: 14px !important;
  font-weight: 700 !important;
  color: #fff !important;
  white-space: nowrap !important;
  overflow: hidden !important;
  text-overflow: ellipsis !important;
}
#nf-floating-widget .nf-close-btn {
  background: rgba(255, 255, 255, 0.08) !important;
  border: 1px solid rgba(255, 255, 255, 0.12) !important;
  color: #94a3b8 !important;
  font-size: 14px !important;
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
  color: #fff !important;
  background: rgba(239, 68, 68, 0.25) !important;
  border-color: rgba(239, 68, 68, 0.5) !important;
}

/* KPI 统计条 */
#nf-floating-widget .nf-kpi-bar {
  display: grid !important;
  grid-template-columns: repeat(3, 1fr) !important;
  gap: 10px !important;
  padding: 14px 20px 10px 20px !important;
  background: rgba(15, 23, 42, 0.5) !important;
  border-bottom: 1px solid rgba(255, 255, 255, 0.06) !important;
  flex-shrink: 0 !important;
}
#nf-floating-widget .nf-kpi-item {
  background: rgba(30, 41, 59, 0.5) !important;
  border: 1px solid rgba(255, 255, 255, 0.06) !important;
  padding: 8px 10px !important;
  border-radius: 10px !important;
  display: flex !important;
  flex-direction: column !important;
  gap: 2px !important;
}
#nf-floating-widget .nf-kpi-lbl {
  font-size: 10px !important;
  color: #94a3b8 !important;
  text-transform: uppercase !important;
  letter-spacing: 0.02em !important;
}
#nf-floating-widget .nf-kpi-val {
  font-size: 13px !important;
  font-weight: 700 !important;
  color: #fff !important;
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
  background: rgba(15, 23, 42, 0.2) !important;
  border-bottom: 1px solid rgba(255, 255, 255, 0.04) !important;
  overflow-x: auto !important;
  flex-shrink: 0 !important;
}
#nf-floating-widget .nf-filter-bar::-webkit-scrollbar {
  display: none !important;
}
#nf-floating-widget .nf-filter-btn {
  background: rgba(255, 255, 255, 0.05) !important;
  border: 1px solid rgba(255, 255, 255, 0.07) !important;
  color: #94a3b8 !important;
  padding: 5px 12px !important;
  border-radius: 20px !important;
  font-size: 11px !important;
  font-weight: 500 !important;
  cursor: pointer !important;
  white-space: nowrap !important;
  transition: all 0.15s ease !important;
}
#nf-floating-widget .nf-filter-btn:hover {
  color: #fff !important;
  background: rgba(255, 255, 255, 0.1) !important;
}
#nf-floating-widget .nf-filter-btn.active {
  background: rgba(99, 102, 241, 0.25) !important;
  border-color: rgba(99, 102, 241, 0.55) !important;
  color: #a5b4fc !important;
  font-weight: 700 !important;
}

/* 节点列表容器 (充裕内边距，滚动顺滑) */
#nf-floating-widget .nf-list {
  flex: 1 !important;
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

/* 单节点精炼卡片 (带有明显独立卡片背景、边框、投影和充裕内边距) */
#nf-floating-widget .nf-node-card {
  background: rgba(30, 41, 59, 0.72) !important;
  border: 1px solid rgba(255, 255, 255, 0.1) !important;
  border-radius: 14px !important;
  padding: 13px 15px !important;
  display: flex !important;
  flex-direction: column !important;
  gap: 8px !important;
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.3) !important;
  transition: all 0.18s ease !important;
}
#nf-floating-widget .nf-node-card:hover {
  background: rgba(30, 41, 59, 0.9) !important;
  border-color: rgba(255, 255, 255, 0.18) !important;
  transform: translateY(-1px) !important;
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
  font-size: 13px !important;
  font-weight: 700 !important;
  color: #fff !important;
  white-space: nowrap !important;
  overflow: hidden !important;
  text-overflow: ellipsis !important;
}
#nf-floating-widget .nf-mode-badge {
  font-size: 10px !important;
  background: rgba(99, 102, 241, 0.18) !important;
  border: 1px solid rgba(99, 102, 241, 0.4) !important;
  color: #a5b4fc !important;
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
  font-size: 10px !important;
  font-weight: 700 !important;
  padding: 2px 7px !important;
  border-radius: 6px !important;
  display: inline-flex !important;
  align-items: center !important;
}
#nf-floating-widget .nf-badge.critical {
  background: rgba(239, 68, 68, 0.25) !important;
  color: #fca5a5 !important;
  border: 1px solid rgba(239, 68, 68, 0.5) !important;
}
#nf-floating-widget .nf-badge.warning {
  background: rgba(245, 158, 11, 0.25) !important;
  color: #fde68a !important;
  border: 1px solid rgba(245, 158, 11, 0.5) !important;
}
#nf-floating-widget .nf-badge.safe {
  background: rgba(16, 185, 129, 0.2) !important;
  color: #a7f3d0 !important;
  border: 1px solid rgba(16, 185, 129, 0.4) !important;
}
#nf-floating-widget .nf-badge.no-quota {
  background: rgba(148, 163, 184, 0.18) !important;
  color: #cbd5e1 !important;
  border: 1px solid rgba(148, 163, 184, 0.3) !important;
}
#nf-floating-widget .nf-pct {
  font-size: 12px !important;
  font-weight: 700 !important;
  color: #38bdf8 !important;
}
#nf-floating-widget .nf-pct.critical {
  color: #ef4444 !important;
}

#nf-floating-widget .nf-bar-bg {
  width: 100% !important;
  height: 8px !important;
  background: rgba(15, 23, 42, 0.85) !important;
  border-radius: 4px !important;
  overflow: hidden !important;
  position: relative !important;
  display: flex !important;
  margin: 2px 0 !important;
}
#nf-floating-widget .nf-bar-used {
  height: 100% !important;
  background: #6366f1 !important;
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
  font-size: 11px !important;
  color: #94a3b8 !important;
  padding-top: 1px !important;
}
#nf-floating-widget .nf-row-meta strong {
  color: #f1f5f9 !important;
}
#nf-floating-widget .nf-row-meta .nf-speed {
  color: #38bdf8 !important;
  font-weight: 600 !important;
}

/* 底部 Footer */
#nf-floating-widget .nf-footer {
  padding: 13px 20px !important;
  border-top: 1px solid rgba(255, 255, 255, 0.08) !important;
  background: rgba(15, 23, 42, 0.85) !important;
  display: flex !important;
  justify-content: space-between !important;
  align-items: center !important;
  flex-shrink: 0 !important;
}
#nf-floating-widget .nf-footer-status {
  font-size: 11px !important;
  color: #94a3b8 !important;
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
  font-size: 12px !important;
  color: #fff !important;
  background: linear-gradient(135deg, #4f46e5 0%, #06b6d4 100%) !important;
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
</style>`;

const WIDGET_BODY_HTML = `
<div id="nf-floating-widget">
  <!-- 1. 可拖拽方形图标按钮 (无文字，状态边框变色) -->
  <div class="nf-trigger-sq safe" id="nfTriggerBtn" title="流量预测 (可拖拽移动位置)">
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
      <line x1="18" y1="20" x2="18" y2="10"></line>
      <line x1="12" y1="20" x2="12" y2="4"></line>
      <line x1="6" y1="20" x2="6" y2="14"></line>
      <path d="M3 14l5-4 5 3 7-7"></path>
    </svg>
    <div class="nf-sq-dot" id="nfSqDot"></div>
  </div>

  <!-- 2. 精致展开看板 (留足边距，精简布局) -->
  <div class="nf-widget-card" id="nfWidgetCard">
    <div class="nf-header">
      <div class="nf-header-title">
        <div class="nf-header-icon">📊</div>
        <span class="nf-header-text" id="nfWhTitle">流量预测与预算监控</span>
      </div>
      <button class="nf-close-btn" id="nfCloseBtn" title="关闭 (✕)">✕</button>
    </div>

    <!-- 顶部 KPI -->
    <div class="nf-kpi-bar">
      <div class="nf-kpi-item"><span class="nf-kpi-lbl" id="nfKpiUsedLbl">配额总已用</span><span class="nf-kpi-val" id="nfKpiUsedVal" style="color:#38bdf8;">-</span></div>
      <div class="nf-kpi-item"><span class="nf-kpi-lbl" id="nfKpiRiskLbl">超限风险</span><span class="nf-kpi-val" id="nfKpiRiskVal">-</span></div>
      <div class="nf-kpi-item"><span class="nf-kpi-lbl" id="nfKpiResetLbl">最近重置</span><span class="nf-kpi-val" id="nfKpiResetVal" style="color:#fde68a;">-</span></div>
    </div>

    <!-- 筛选药丸 (单节点页面增加当前节点药丸) -->
    <div class="nf-filter-bar" id="nfFilterBar">
      <button class="nf-filter-btn" data-filter="CURRENT" id="nfBtnCurrent" style="display:none;">📌 当前 (1)</button>
      <button class="nf-filter-btn active" data-filter="ALL" id="nfBtnAll">全部 (0)</button>
      <button class="nf-filter-btn" data-filter="ALERT" id="nfBtnAlert">🚨 预警 (0)</button>
      <button class="nf-filter-btn" data-filter="SAFE" id="nfBtnSafe">✅ 安全 (0)</button>
      <button class="nf-filter-btn" data-filter="NO_QUOTA" id="nfBtnNoQuota">⚪ 免额 (0)</button>
    </div>

    <!-- 精简节点列表 -->
    <div class="nf-list" id="nfNodeList">
      <div style="text-align:center; padding:28px; color:#94a3b8; font-size:12px;">正在计算全节点流量与预算预测...</div>
    </div>

    <!-- 底部动作条 -->
    <div class="nf-footer">
      <div class="nf-footer-status"><div class="nf-live-dot"></div><span id="nfFooterStatus">实时监测中</span></div>
      <a href="/api/plugin/net-forecast/pages/public.html" target="_blank" class="nf-btn-full" id="nfFooterFullBtn">完整图表 ↗</a>
    </div>
  </div>
</div>
<script>
(function() {
  function nfIsAdminPath() {
    try {
      var p = (window.location.pathname || "").toLowerCase();
      return p.indexOf("/admin") === 0;
    } catch (e) {
      return false;
    }
  }

  var widgetRoot = document.getElementById("nf-floating-widget");
  if (widgetRoot) {
    widgetRoot.style.display = nfIsAdminPath() ? "none" : "block";
  }

  // 稳健提取当前节点 ID (免正则转义干扰，全面支持 pathname / hash / search)
  function getCurrentInstanceUuid() {
    try {
      // 1. Pathname (e.g. /instance/:id, /instances/:id, /node/:id, /server/:id)
      var pathname = (window.location.pathname || "").trim();
      var pathParts = pathname.split("/").filter(Boolean);
      for (var i = 0; i < pathParts.length; i++) {
        var seg = pathParts[i].toLowerCase();
        if ((seg === "instance" || seg === "instances" || seg === "node" || seg === "nodes" || seg === "server" || seg === "client") && pathParts[i + 1]) {
          var cand = decodeURIComponent(pathParts[i + 1]).trim();
          if (cand) return cand;
        }
      }

      // 2. Hash (e.g. #/instance/:id)
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

      // 3. Search query (?uuid=... or ?node_id=... or ?id=...)
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

    // 1. 严格精确匹配 (node_id / uuid / node_name)
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      var id = String(n.node_id || n.uuid || "").trim().toLowerCase();
      var name = String(n.node_name || n.name || "").trim().toLowerCase();
      if (id === target || name === target) {
        return n;
      }
    }

    // 2. 忽略连字符匹配 (防 URL 省略 uuid 连字符)
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

    // 3. 短 UUID 前缀匹配 (适配前端短路由截取)
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

  function nfCheckRoute() {
    var el = document.getElementById("nf-floating-widget");
    if (!el) return;
    if (nfIsAdminPath()) {
      el.style.display = "none";
    } else {
      el.style.display = "block";
      if (cachedData && cachedData.nodes) {
        renderData(cachedData);
      }
    }
  }
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

  var isEn = (navigator.language || "").toLowerCase().startsWith("en");
  var btn = document.getElementById("nfTriggerBtn");
  var card = document.getElementById("nfWidgetCard");
  var closeBtn = document.getElementById("nfCloseBtn");
  var sqDot = document.getElementById("nfSqDot");
  var filterBar = document.getElementById("nfFilterBar");
  var whTitle = document.getElementById("nfWhTitle");
  var kpiUsedLbl = document.getElementById("nfKpiUsedLbl");
  var kpiRiskLbl = document.getElementById("nfKpiRiskLbl");
  var kpiResetLbl = document.getElementById("nfKpiResetLbl");
  var kpiUsedVal = document.getElementById("nfKpiUsedVal");
  var kpiRiskVal = document.getElementById("nfKpiRiskVal");
  var kpiResetVal = document.getElementById("nfKpiResetVal");
  var btnCurrent = document.getElementById("nfBtnCurrent");
  var btnAll = document.getElementById("nfBtnAll");
  var btnAlert = document.getElementById("nfBtnAlert");
  var btnSafe = document.getElementById("nfBtnSafe");
  var btnNoQuota = document.getElementById("nfBtnNoQuota");
  var nodeList = document.getElementById("nfNodeList");
  var footerStatus = document.getElementById("nfFooterStatus");
  var footerFullBtn = document.getElementById("nfFooterFullBtn");

  if (isEn) {
    if (btn) btn.title = "Traffic Forecast (Drag to move)";
    if (whTitle) whTitle.textContent = "Traffic & Quota Forecast";
    if (kpiUsedLbl) kpiUsedLbl.textContent = "TOTAL USED";
    if (kpiRiskLbl) kpiRiskLbl.textContent = "AT RISK";
    if (kpiResetLbl) kpiResetLbl.textContent = "NEXT RESET";
    if (footerStatus) footerStatus.textContent = "Live Monitoring";
    if (footerFullBtn) footerFullBtn.textContent = "Full Chart ↗";
  }

  // 2. 拖拽与记住最后位置 (Draggable & Persisted Position)
  var posKey = "nf_btn_pos_v2";
  function loadSavedPos() {
    try {
      var raw = localStorage.getItem(posKey);
      if (raw) {
        var p = JSON.parse(raw);
        if (typeof p.left === "number" && typeof p.top === "number") {
          var maxL = Math.max(10, window.innerWidth - 60);
          var maxT = Math.max(10, window.innerHeight - 60);
          var l = Math.max(10, Math.min(maxL, p.left));
          var t = Math.max(10, Math.min(maxT, p.top));
          btn.style.setProperty("left", l + "px", "important");
          btn.style.setProperty("top", t + "px", "important");
          btn.style.setProperty("right", "auto", "important");
          btn.style.setProperty("bottom", "auto", "important");
          return;
        }
      }
    } catch (e) {}
    btn.style.setProperty("right", "28px", "important");
    btn.style.setProperty("bottom", "28px", "important");
    btn.style.setProperty("left", "auto", "important");
    btn.style.setProperty("top", "auto", "important");
  }
  loadSavedPos();

  var isDragging = false;
  var startX = 0, startY = 0;
  var origL = 0, origT = 0;

  btn.addEventListener("pointerdown", function(e) {
    if (e.button !== 0) return;
    btn.setPointerCapture(e.pointerId);
    isDragging = false;
    startX = e.clientX;
    startY = e.clientY;
    var rect = btn.getBoundingClientRect();
    origL = rect.left;
    origT = rect.top;
  });

  btn.addEventListener("pointermove", function(e) {
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
    }
  });

  btn.addEventListener("pointerup", function(e) {
    if (!btn.hasPointerCapture(e.pointerId)) return;
    btn.releasePointerCapture(e.pointerId);
    if (isDragging) {
      var rect = btn.getBoundingClientRect();
      try {
        localStorage.setItem(posKey, JSON.stringify({ left: rect.left, top: rect.top }));
      } catch (err) {}
    } else {
      toggle();
    }
  });

  btn.addEventListener("click", function(e) {
    e.stopPropagation();
    e.preventDefault();
    if (isDragging) return;
    if (!isOpen) {
      openCard();
    }
  });

  // 3. 动态定位展开面板 (避免屏幕溢出)
  function positionCard() {
    var bRect = btn.getBoundingClientRect();
    var cardW = Math.min(440, window.innerWidth - 28);
    card.style.setProperty("width", cardW + "px", "important");

    // 水平方向自适应
    if (bRect.left + cardW > window.innerWidth - 14) {
      var r = Math.max(12, window.innerWidth - bRect.right);
      card.style.setProperty("right", r + "px", "important");
      card.style.setProperty("left", "auto", "important");
    } else {
      var l = Math.max(12, bRect.left);
      card.style.setProperty("left", l + "px", "important");
      card.style.setProperty("right", "auto", "important");
    }

    // 垂直方向自适应
    if (bRect.top > window.innerHeight / 2) {
      var b = Math.max(12, window.innerHeight - bRect.top + 10);
      card.style.setProperty("bottom", b + "px", "important");
      card.style.setProperty("top", "auto", "important");
    } else {
      var t = Math.max(12, bRect.bottom + 10);
      card.style.setProperty("top", t + "px", "important");
      card.style.setProperty("bottom", "auto", "important");
    }
  }

  var isOpen = false;
  var currentFilter = "ALL";
  var cachedData = null;

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
    positionCard();
    card.style.setProperty("display", "flex", "important");
    card.classList.add("nf-open");

    if (cachedData && cachedData.nodes && cachedData.nodes.length > 0) {
      renderData(cachedData);
    } else {
      fetchAndCompute();
    }
  }

  function closeCard() {
    isOpen = false;
    card.style.setProperty("display", "none", "important");
    card.classList.remove("nf-open");
  }

  function toggle() {
    if (isOpen) {
      closeCard();
    } else {
      openCard();
    }
  }

  // 关闭按钮点击绑定
  if (closeBtn) {
    closeBtn.addEventListener("click", function(e) {
      e.stopPropagation();
      e.preventDefault();
      closeCard();
    });
  }

  // 点击外部空白区域自动关闭
  document.addEventListener("pointerdown", function(e) {
    if (!isOpen) return;
    if (card && card.contains(e.target)) return;
    if (btn && btn.contains(e.target)) return;
    closeCard();
  });

  // ESC 键关闭
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
          kpiRiskVal.style.color = ratioPct >= 100 ? "#ef4444" : (ratioPct >= 90 ? "#fde68a" : "#6ee7b7");
        } else {
          kpiRiskVal.textContent = isEn ? "Uncapped" : "免额度";
          kpiRiskVal.style.color = "#cbd5e1";
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
        kpiRiskVal.style.color = totalAlerts > 0 ? "#fca5a5" : "#6ee7b7";
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
      nodeList.innerHTML = '<div style="text-align:center; padding:32px; color:#94a3b8; font-size:12px;">' + (isEn ? "No matching nodes" : "无符合条件的节点") + '</div>';
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
        var usedColor = isCrit ? "#ef4444" : "#6366f1";
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

      html += '<div class="nf-node-card">' +
        '<div class="nf-row-head">' +
          '<div class="nf-node-name-wrap">' +
            '<span class="nf-node-name">' + (n.node_name || n.node_id) + '</span>' +
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
  }

  function renderData(data) {
    cachedData = data;
    var summary = data.summary || {};
    var nodes = data.nodes || [];
    var instanceUuid = getCurrentInstanceUuid();
    var singleNode = instanceUuid ? findMatchingNode(nodes, instanceUuid) : null;

    // 1. 设置方形图标状态
    if (singleNode) {
      var isSingleAlert = singleNode.status === "CRITICAL" || singleNode.status === "WARNING";
      if (isSingleAlert) {
        btn.className = "nf-trigger-sq alert";
        if (sqDot) sqDot.className = "nf-sq-dot alert";
      } else {
        btn.className = "nf-trigger-sq safe";
        if (sqDot) sqDot.className = "nf-sq-dot";
      }
    } else {
      var totalAlerts = (summary.critical_count || 0) + (summary.warning_count || 0);
      if (totalAlerts > 0) {
        btn.className = "nf-trigger-sq alert";
        if (sqDot) sqDot.className = "nf-sq-dot alert";
      } else {
        btn.className = "nf-trigger-sq safe";
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
      var baseRes = await fetch("/api/plugin/net-forecast/overview");
      if (!baseRes.ok) return;
      var baseJson = await baseRes.json();
      if (!baseJson || !baseJson.ok || !Array.isArray(baseJson.nodes)) return;

      var nodes = baseJson.nodes;
      renderData(baseJson);

      var enrichedClients = await Promise.all(nodes.map(async function(node) {
        var netTotalUp = (node.cumulative && node.cumulative.out_bytes) || 0;
        var netTotalDown = (node.cumulative && node.cumulative.in_bytes) || 0;

        try {
          var rRes = await fetch("/api/recent/" + encodeURIComponent(node.node_id), { cache: "no-store" });
          if (rRes.ok) {
            var rJson = await rRes.json();
            var recList = (rJson.data && Array.isArray(rJson.data)) ? rJson.data : (Array.isArray(rJson) ? rJson : []);
            if (recList.length > 0) {
              var latest = recList[recList.length - 1];
              if (latest.network) {
                netTotalUp = Number(latest.network.totalUp || latest.network.total_up || netTotalUp);
                netTotalDown = Number(latest.network.totalDown || latest.network.total_down || netTotalDown);
              }
              if (typeof latest.net_total_up === "number") netTotalUp = latest.net_total_up;
              if (typeof latest.net_total_down === "number") netTotalDown = latest.net_total_down;
            }
          }
        } catch (e) {}

        return {
          uuid: node.node_id,
          name: node.node_name,
          traffic_limit: node.traffic_limit_bytes,
          traffic_limit_type: node.traffic_limit_type,
          expired_at: node.expired_at_raw,
          traffic_reset_day: node.traffic_reset_day,
          net_total_up: netTotalUp,
          net_total_down: netTotalDown
        };
      }));

      var calcRes = await fetch("/api/plugin/net-forecast/overview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clients: enrichedClients })
      });

      if (calcRes.ok) {
        var calcJson = await calcRes.json();
        if (calcJson && calcJson.ok) {
          renderData(calcJson);
        }
      }
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

  // 1. 全节点 30 天预测总览接口
  const handleOverview = async (req, res) => {
    try {
      const config = getConfig();
      const body = req.body ? parseBody(req.body) : {};
      let clients = await fetchCoreClients(body.clients);

      if (!clients) {
        clients = [];
      }

      const list = clients.map((c) => {
        if (typeof c.net_in === "number" && typeof c.net_out === "number") {
          storage.recordSample(c.uuid, c.net_in, c.net_out);
        }
        const history = Array.isArray(c.daily_history) && c.daily_history.length > 0
          ? c.daily_history
          : storage.getNodeHistory(c.uuid);

        return calculateNodeForecast(history, c, config.warning_threshold);
      });

      const criticalCount = list.filter((n) => n.status === "CRITICAL").length;
      const warningCount = list.filter((n) => n.status === "WARNING").length;
      const safeCount = list.filter((n) => n.status === "SAFE").length;
      const noQuotaCount = list.filter((n) => n.status === "NO_QUOTA").length;

      sendJSON(res, {
        ok: true,
        summary: {
          total_nodes: list.length,
          critical_count: criticalCount,
          warning_count: warningCount,
          safe_count: safeCount,
          no_quota_count: noQuotaCount,
        },
        nodes: list,
      });
    } catch (e) {
      sendJSON(res, { ok: false, error: e.message || String(e) }, 500);
    }
  };

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
            for (const c of clients) {
              if (c.uuid && typeof c.net_in === "number" && typeof c.net_out === "number") {
                storage.recordSample(c.uuid, c.net_in, c.net_out);
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
    const config = getConfig();
    const clients = await fetchCoreClients();
    return {
      ok: true,
      nodes: clients.map((c) => {
        const history = storage.getNodeHistory(c.uuid);
        return calculateNodeForecast(history, c, config.warning_threshold);
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
