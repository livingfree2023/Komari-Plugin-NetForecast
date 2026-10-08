import * as fs from "fs";
import * as path from "path";
import { TrafficRecord } from "./types";

declare const __storageDir__: string | undefined;

export class StorageManager {
  private baseDir: string;
  private trafficFile: string;

  private trafficCache: Record<string, TrafficRecord[]> = {};
  private lastKnownCounters: Record<string, { in: number; out: number; time: number }> = {};

  constructor() {
    if (typeof __storageDir__ !== "undefined" && __storageDir__) {
      this.baseDir = __storageDir__;
    } else {
      this.baseDir = path.join(process.cwd(), "data", "net-forecast");
    }

    try {
      if (!fs.existsSync(this.baseDir)) {
        fs.mkdirSync(this.baseDir, { recursive: true });
      }
    } catch (e) {
      console.error("[NetForecast] Failed to create storage dir:", e);
    }

    this.trafficFile = path.join(this.baseDir, "traffic_records.json");
    this.load();
  }

  public load() {
    try {
      if (fs.existsSync(this.trafficFile)) {
        const raw = fs.readFileSync(this.trafficFile, "utf-8");
        const parsed = JSON.parse(raw);
        const records = parsed.records || {};
        
        // 过滤清理历史遗留的虚拟模拟种子数据（杜绝假数据污染）
        this.trafficCache = {};
        for (const nodeId of Object.keys(records)) {
          const list: TrafficRecord[] = records[nodeId] || [];
          // 如果列表是旧版种子生成的 31 条连续且每日都为 10-35G 的模拟数据，予以清理
          const isLegacySeed = list.length === 31 && list.every(r => r.total_bytes >= 10 * 1024 * 1024 * 1024 && r.total_bytes <= 35 * 1024 * 1024 * 1024);
          if (!isLegacySeed) {
            this.trafficCache[nodeId] = list;
          }
        }
        this.lastKnownCounters = parsed.last_counters || {};
      }
    } catch (err) {
      console.warn("[NetForecast] Error reading traffic file:", err);
      this.trafficCache = {};
    }
  }

  public save() {
    try {
      if (!fs.existsSync(this.baseDir)) {
        fs.mkdirSync(this.baseDir, { recursive: true });
      }

      fs.writeFileSync(
        this.trafficFile,
        JSON.stringify(
          {
            records: this.trafficCache,
            last_counters: this.lastKnownCounters,
            updated_at: new Date().toISOString(),
          },
          null,
          2
        ),
        "utf-8"
      );
    } catch (err) {
      console.error("[NetForecast] Failed to save storage:", err);
    }
  }

  /**
   * 获取节点历史采样记录。如无采样记录，严格返回空数组，绝不生成假数据。
   */
  public getNodeHistory(nodeId: string): TrafficRecord[] {
    return this.trafficCache[nodeId] || [];
  }

  /**
   * 设置/覆盖节点历史记录（例如从核心接口同步历史记录时）
   */
  public setNodeHistory(nodeId: string, history: TrafficRecord[]) {
    this.trafficCache[nodeId] = history;
    this.save();
  }

  /**
   * 记录实时采样的流量计数器并换算为每日增量
   */
  public recordSample(nodeId: string, currentIn: number, currentOut: number, now: Date = new Date()) {
    const last = this.lastKnownCounters[nodeId];
    this.lastKnownCounters[nodeId] = {
      in: currentIn,
      out: currentOut,
      time: now.getTime(),
    };

    if (!last) {
      // 第一次采样仅记录基线
      this.save();
      return;
    }

    // 增量计算，考虑网卡计数器回绕（reset/overflow）
    let deltaIn = currentIn >= last.in ? currentIn - last.in : currentIn;
    let deltaOut = currentOut >= last.out ? currentOut - last.out : currentOut;

    // 忽略异常的超大跳跃（如 > 500GB 单次间隔）
    if (deltaIn > 500 * 1024 * 1024 * 1024) deltaIn = 0;
    if (deltaOut > 500 * 1024 * 1024 * 1024) deltaOut = 0;

    // 如果两者均为 0 则无需额外产生空写
    if (deltaIn === 0 && deltaOut === 0) {
      return;
    }

    const todayStr = now.toISOString().split("T")[0];
    const history = this.trafficCache[nodeId] || [];
    let todayRecord = history.find((r) => r.date === todayStr);

    if (todayRecord) {
      todayRecord.in_bytes += deltaIn;
      todayRecord.out_bytes += deltaOut;
      todayRecord.total_bytes = todayRecord.in_bytes + todayRecord.out_bytes;
      todayRecord.timestamp = now.getTime();
    } else {
      todayRecord = {
        date: todayStr,
        timestamp: now.getTime(),
        in_bytes: deltaIn,
        out_bytes: deltaOut,
        total_bytes: deltaIn + deltaOut,
      };
      history.push(todayRecord);
    }

    // 保留最近 90 天的历史
    if (history.length > 90) {
      history.splice(0, history.length - 90);
    }

    this.trafficCache[nodeId] = history;
    this.save();
  }
}
