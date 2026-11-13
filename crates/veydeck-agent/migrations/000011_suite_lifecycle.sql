-- 依赖 Agent 的套件运行意图；安装时创建，独立于容器实际状态。
CREATE TABLE suite_lifecycle (
    project_name TEXT PRIMARY KEY REFERENCES docker_compose_projects(name) ON DELETE CASCADE,
    desired_state TEXT NOT NULL DEFAULT 'disabled' CHECK (desired_state IN ('enabled', 'disabled')),
    last_error TEXT,
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);
