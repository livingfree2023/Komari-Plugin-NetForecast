export interface TrafficRecord {
  date: string; // YYYY-MM-DD or YYYY-MM-DD HH:00
  timestamp: number;
  in_bytes: number;
  out_bytes: number;
  total_bytes: number;
  cumulative_bytes?: number;
  is_forecast?: boolean;
}

export interface NodeQuotaConfig {
  node_id: string;
  node_name?: string;
  quota_bytes: number; // 0 means unlimited
  reset_day: number; // 1-31
  traffic_limit_type?: "sum" | "out" | "in" | "max";
}

export interface NodeTrafficData {
  node_id: string;
  node_name: string;
  node_group?: string;
  status?: string;
  quota_config: NodeQuotaConfig;
  current_cycle: {
    cycle_start: string;
    cycle_end: string;
    days_total: number;
    days_elapsed: number;
    days_remaining: number;
    cumulative_in_bytes: number;
    cumulative_out_bytes: number;
    cumulative_total_bytes: number;
  };
  daily_history: TrafficRecord[]; // Last 30+ days
  hourly_history?: TrafficRecord[]; // Last 24 hours
  forecast: {
    daily_avg_in_bytes: number;
    daily_avg_out_bytes: number;
    daily_avg_total_bytes: number;
    projected_in_bytes: number;
    projected_out_bytes: number;
    projected_total_bytes: number;
    quota_bytes: number;
    usage_ratio_current: number; // 0.0 - 1.0+
    usage_ratio_projected: number; // 0.0 - 1.0+
    status: "SAFE" | "WARNING" | "CRITICAL";
    days_until_exhaustion?: number;
    exhaustion_date?: string;
    warning_message?: string;
  };
}

export interface PluginConfig {
  default_reset_day: number;
  warning_threshold: number;
  auto_collect_cron: string;
}
