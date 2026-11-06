-- 新增 Swap 历史利用率，未采集的旧样本保持 NULL。
ALTER TABLE system_monitoring_samples ADD COLUMN swap_percent REAL;
