-- 保留安装失败的业务错误码，用于重启恢复及界面国际化。
ALTER TABLE suite_install_tasks ADD COLUMN error_code TEXT;
