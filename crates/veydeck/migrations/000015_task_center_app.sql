-- 任务中心使用标准桌面应用窗口，展示元数据由应用目录统一提供。
INSERT OR IGNORE INTO apps (
    app_id, i18n_title_key, icon, default_width, default_height,
    min_width, min_height, hidden, sort_order
)
VALUES (
    'task-center', 'taskCenter.title', '/images/apps/platform-log.png',
    1024, 640, 640, 360, 0, 151
);
