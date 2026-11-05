-- 为任务中心设置专属应用图标，不复用平台日志资产。
UPDATE apps SET icon = '/images/apps/task-center.png' WHERE app_id = 'task-center';
