//! Agent 卸载前的依赖清单：登记、元数据和遗留容器相互补充。

use crate::Context;
use anyhow::{Context as _, Result, bail};
use serde_json::Value;
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

/// 完整检查依赖；任何读取或 Docker 查询失败都必须显式中断卸载。
pub fn ensure_clear(context: &Context) -> Result<()> {
    let mut directories = BTreeSet::new();
    let mut dependencies = BTreeSet::new();
    let database = context.db_dir.join("agent.db");
    if database.try_exists()? {
        let connection = rusqlite::Connection::open_with_flags(
            &database,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )?;
        let mut statement = connection.prepare(
            "SELECT compose_dir FROM docker_compose_projects WHERE management_kind='suite'",
        )?;
        for directory in statement.query_map([], |row| row.get::<_, String>(0))? {
            directories.insert(PathBuf::from(directory?));
        }
    }
    let config = context.config_dir.join("agent.toml");
    let compose_root = if config.try_exists()? {
        let config: toml::Value = toml::from_str(&std::fs::read_to_string(config)?)?;
        config
            .get("composeRootDir")
            .and_then(toml::Value::as_str)
            .map(PathBuf::from)
    } else {
        None
    };
    let root = compose_root.unwrap_or_else(|| context.veydeck_home.join("data/compose"));
    let root = if root.is_absolute() {
        root
    } else {
        context.veydeck_home.join(root)
    };
    let root = root.join("suite");
    if root.try_exists()? {
        for entry in std::fs::read_dir(root)? {
            let entry = entry?;
            if !entry.file_type()?.is_dir() {
                bail!("Cannot verify suite directory type: {}", entry.path().display());
            }
            directories.insert(entry.path());
        }
    }
    for directory in directories {
        let path = directory.join("suite-agent.json");
        let metadata: Value = serde_json::from_str(
            &std::fs::read_to_string(&path)
                .with_context(|| format!("Cannot verify suite metadata at {}", path.display()))?,
        )?;
        if let Some(dependency) = metadata_dependency(&metadata)? {
            dependencies.insert(dependency);
        }
    }
    if crate::command_exists("docker") {
        let ids = checked_docker(&["ps", "--all", "--quiet"])?;
        // 分批 inspect，避免容器数量大时超过系统参数长度。
        let ids: Vec<_> = ids.lines().filter(|id| !id.is_empty()).collect();
        for chunk in ids.chunks(64) {
            let mut args = vec!["inspect"];
            args.extend_from_slice(chunk);
            let containers: Vec<Value> = serde_json::from_str(&checked_docker(&args)?)?;
            for container in containers {
                if let Some(dependency) = container_dependency(&container, &context.agent_socket) {
                    dependencies.insert(dependency);
                }
            }
        }
    } else if Path::new("/var/run/docker.sock").try_exists()?
        || Path::new("/var/lib/docker/containers").try_exists()?
    {
        bail!("Cannot check Agent dependencies: Docker CLI is missing, but a local Docker runtime or container directory still exists");
    }
    if !dependencies.is_empty() {
        bail!(
            "Cannot uninstall Agent: dependent suites or containers remain. Uninstall the suites first; disabling does not remove dependencies:\n{}",
            dependencies
                .into_iter()
                .map(|item| format!("  - {item}"))
                .collect::<Vec<_>>()
                .join("\n")
        );
    }
    Ok(())
}

/// 检查 Docker 命令退出码，不能把守护进程不可用误判为空清单。
fn checked_docker(args: &[&str]) -> Result<String> {
    let output = std::process::Command::new("docker")
        .args(["--host", "unix:///var/run/docker.sock"])
        .args(args)
        .output()?;
    if !output.status.success() {
        bail!(
            "Cannot check Agent dependencies: docker {}: {}",
            args.join(" "),
            String::from_utf8_lossy(&output.stderr)
        );
    }
    Ok(String::from_utf8(output.stdout)?)
}

/// 已停用的授权仍代表安装依赖，不能只检查 enabled 字段。
fn metadata_dependency(metadata: &Value) -> Result<Option<String>> {
    let object = metadata.as_object().context("Suite metadata must be an object")?;
    let suite = object
        .get("suiteId")
        .and_then(Value::as_str)
        .context("Suite metadata is missing suiteId")?;
    let instance = object
        .get("instanceId")
        .and_then(Value::as_str)
        .context("Suite metadata is missing instanceId")?;
    let project = object
        .get("composeProjectName")
        .and_then(Value::as_str)
        .context("Suite metadata is missing composeProjectName")?;
    if object
        .get("agentAccess")
        .is_some_and(|access| !access.is_null())
    {
        return Ok(Some(format!("suite={suite} instance={instance} project={project}")));
    }
    Ok(None)
}

/// 挂载与标签识别失去登记的旧容器，不依赖运行状态。
fn container_dependency(container: &Value, socket: &Path) -> Option<String> {
    let labels = &container["Config"]["Labels"];
    let workload = labels["veydeck.workload_id"].is_string();
    let required = labels["veydeck.agent.required"].as_str() == Some("true")
        || workload
        || container["Mounts"].as_array().is_some_and(|mounts| {
            mounts.iter().any(|mount| {
                let target = mount["Destination"].as_str().unwrap_or("");
                let source = mount["Source"].as_str().unwrap_or("");
                matches!(
                    target,
                    "/run/veydeck-agent-socket" | "/run/veydeck-agent"
                ) || Path::new(source) == socket
            })
        });
    if !required {
        return None;
    }
    // Compose 套件服务与动态 workload 使用各自的当前资源标签。
    let (suite_key, instance_key) = if workload {
        ("veydeck.suite_id", "veydeck.suite_instance_id")
    } else {
        ("veydeck.suite.id", "veydeck.suite.instance")
    };
    Some(format!(
        "suite={} instance={} project={} container={}",
        labels[suite_key].as_str().unwrap_or("unknown"),
        labels[instance_key].as_str().unwrap_or("unknown"),
        labels["com.docker.compose.project"]
            .as_str()
            .unwrap_or("unregistered"),
        container["Name"]
            .as_str()
            .or_else(|| container["Id"].as_str())
            .unwrap_or("unknown")
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// 停用和登记丢失都不能让依赖穿过卸载检查。
    #[test]
    fn stopped_and_orphaned_dependencies_are_detected() {
        let metadata = json!({"suiteId":"packet", "instanceId":"i", "composeProjectName":"p", "agentAccess":{"enabled":false}});
        assert!(metadata_dependency(&metadata).unwrap().is_some());
        assert!(metadata_dependency(&json!({})).is_err());
        let orphan = json!({"Name":"/packet", "State":{"Running":false}, "Mounts":[{"Destination":"/run/veydeck-agent-socket"}]});
        assert!(container_dependency(&orphan, Path::new("/new/socket")).is_some());
        let unrelated = json!({"Name":"/db", "Mounts":[{"Destination":"/data"}]});
        assert!(container_dependency(&unrelated, Path::new("/new/socket")).is_none());
    }
}
