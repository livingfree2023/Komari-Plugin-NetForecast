export type ThresholdMode = "sum" | "max" | "min" | "upload" | "download" | "up" | "down";

export interface TrafficRecord {
  date: string; // YYYY-MM-DD
  timestamp: number;
  in_bytes: number;
  out_bytes: number;
  total_bytes: number;
  cumulative_bytes?: number;
  cumulative_billable?: number;
  is_forecast?: boolean;
}

/**
 * 对应 Komari 核心数据库中的 Client 字段定义（不作插件本地缓存，直接来源于核心）
 */
export interface NodeCoreConfig {
  uuid: string;
  name: string;
  traffic_limit?: number; // 字节数，0 或 undefined 表示未配置限额
  traffic_limit_type?: ThresholdMode; // sum | max | min | upload (up) | download (down)
  traffic_reset_day?: number; // 每月重置日 1-31
  billing_cycle?: number;
  expired_at?: string | null;
  net_in?: number;
  net_out?: number;
  tags?: string;
  group?: string;
}

export interface BillingCycle {
  cycleStart: string;
  cycleEnd: string;
  cycleStartDate: Date;
  cycleEndDate: Date;
  daysTotal: number;
  daysElapsed: number;
  daysRemaining: number;
}

export interface NodeForecastData {
  node_id: string;
  node_name: string;
  tags?: string;
  group?: string;
  has_quota: boolean;
  traffic_limit_bytes: number;
  traffic_limit_formatted: string;
  traffic_limit_type: ThresholdMode;
  traffic_reset_day: number;
  cycle: BillingCycle;
  cumulative: {
    in_bytes: number;
    out_bytes: number;
    physical_total: number;
    billable_bytes: number;
    in_formatted: string;
    out_formatted: string;
    physical_formatted: string;
    billable_formatted: string;
  };
  daily_avg: {
    in_bytes: number;
    out_bytes: number;
    total_bytes: number;
    billable_bytes: number;
    total_formatted: string;
    billable_formatted: string;
  };
  projected: {
    in_bytes: number;
    out_bytes: number;
    physical_total: number;
    billable_bytes: number;
    physical_formatted: string;
    billable_formatted: string;
  };
  usage_ratio: number; // 0.0 ~ 1.0+
  status: "SAFE" | "WARNING" | "CRITICAL" | "NO_QUOTA";
  days_until_exhaustion?: number;
  exhaustion_date?: string;
  warning_message?: string;
  chart_series: TrafficRecord[]; // 30天实际 + 预测点
}

export interface PluginConfig {
  default_reset_day: number;
  warning_threshold: number;
  auto_collect_cron: string;
}
