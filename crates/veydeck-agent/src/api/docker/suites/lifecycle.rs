//! 依赖套件的持久化运行意图和恢复协调。

use super::*;

/// 更新安装时创建的运行意图，拒绝缺少登记的项目。
pub(super) async fn set_desired_state(
    state: &Arc<AppState>,
    project: &str,
    enabled: bool,
) -> ApiResult<()> {
    let updated = sqlx::query("UPDATE suite_lifecycle SET desired_state=?, updated_at=unixepoch() WHERE project_name=?")
        .bind(if enabled { "enabled" } else { "disabled" }).bind(project)
        .execute(&state.metadata_db).await?;
    if updated.rows_affected() != 1 {
        return Err(ApiError::Internal(format!("Suite lifecycle registration is missing: {project}")));
    }
    Ok(())
}

/// 执行单个项目的恢复；失败保存错误且不改变用户意图。
pub(super) async fn apply_managed_suite(state: &Arc<AppState>, project: &str) -> ApiResult<()> {
    let result = apply_managed_suite_inner(state, project).await;
    sqlx::query(
        "UPDATE suite_lifecycle SET last_error=?, updated_at=unixepoch() WHERE project_name=?",
    )
    .bind(result.as_ref().err().map(ToString::to_string))
    .bind(project)
    .execute(&state.metadata_db)
    .await?;
    let desired: String = sqlx::query_scalar(
        "SELECT desired_state FROM suite_lifecycle WHERE project_name=?",
    ).bind(project).fetch_one(&state.metadata_db).await?;
    if let Ok(metadata) = read_suite_metadata(project).await
        && let Err(error) = state
            .controller_runtime
            .report_suite_state(
                &metadata.instance_id,
                project,
                desired == "enabled",
                result.as_ref().err().map(ToString::to_string),
            )
            .await
    {
        tracing::debug!(project, error = %error, "Suite state report deferred");
    }
    result
}

/// 所有恢复与显式操作均在持有项目锁的条件下执行。
async fn apply_managed_suite_inner(state: &Arc<AppState>, project: &str) -> ApiResult<()> {
    let metadata = read_suite_metadata(project).await?;
    let Some(grant) = &metadata.agent_access else {
        return Ok(());
    };
    let desired: String = sqlx::query_scalar(
        "SELECT desired_state FROM suite_lifecycle WHERE project_name=?"
    ).bind(project).fetch_one(&state.metadata_db).await?;
    let file = suite_project_dir(project).join(COMPOSE_FILE_NAME);
    let ps = compose_output(project, &file, &["ps", "--all", "--format", "json"]).await?;
    let containers = parse_compose_ps(&ps)?;
    if desired == "disabled" {
        if grant.enabled {
            rotate_suite_runtime_token(project, false).await?;
        }
        let docker = state.docker_client().await?;
        suite_workloads::cleanup_suite_workloads_by_instance(&docker, &metadata.instance_id)
            .await?;
        if containers.iter().any(|row| {
            row.get("State")
                .and_then(Value::as_str)
                .is_some_and(|value| matches!(value, "running" | "restarting" | "paused"))
        }) {
            run_compose_command(project, &file, &["stop"]).await?;
            tracing::info!(project, "Disabled suite stopped");
        }
        return Ok(());
    }
    if !grant.enabled {
        rotate_suite_runtime_token(project, true).await?;
    }
    let expected = compose_output(project, &file, &["config", "--services"]).await?;
    let expected = String::from_utf8_lossy(&expected);
    let all_running = expected
        .lines()
        .filter(|name| !name.is_empty())
        .all(|name| {
            containers.iter().any(|row| {
                row.get("Service").and_then(Value::as_str) == Some(name)
                    && row.get("State").and_then(Value::as_str) == Some("running")
            })
        });
    if !all_running {
        ensure_suite_network(state).await?;
        run_compose_command(
            project,
            &file,
            &["up", "-d", "--no-recreate", "--no-build", "--pull", "never"],
        )
        .await?;
        wait_for_suite_entries_ready(state, project, project).await?;
        tracing::info!(project, "Enabled suite containers restored");
    }
    Ok(())
}

/// 同时接受 Compose 的 JSON 数组和逐行 JSON 输出。
fn parse_compose_ps(bytes: &[u8]) -> ApiResult<Vec<Value>> {
    if bytes.iter().all(u8::is_ascii_whitespace) {
        return Ok(Vec::new());
    }
    if let Ok(Value::Array(rows)) = serde_json::from_slice(bytes) {
        return Ok(rows);
    }
    serde_json::Deserializer::from_slice(bytes)
        .into_iter::<Value>()
        .map(|item| {
            item.map_err(|error| ApiError::Internal(format!("invalid Compose state: {error}")))
        })
        .collect()
}

/// 扫描节点登记的套件，逐项目恢复并记录有退避的错误状态。
pub(crate) async fn reconcile_projects(
    state: &Arc<AppState>,
    retries: &mut HashMap<String, (Instant, u64)>,
) -> ApiResult<()> {
    let projects = sqlx::query_scalar::<_, String>(
        "SELECT name FROM docker_compose_projects WHERE management_kind='suite' ORDER BY name",
    )
    .fetch_all(&state.metadata_db)
    .await?;
    for project in projects {
        if retries
            .get(&project)
            .is_some_and(|(next, _)| *next > Instant::now())
        {
            continue;
        }
        let previous: Option<String> =
            sqlx::query_scalar("SELECT last_error FROM suite_lifecycle WHERE project_name=?")
                .bind(&project)
                .fetch_optional(&state.metadata_db)
                .await?
                .flatten();
        let result = async {
            let _lifecycle = suite_lifecycle::change_guard()?;
            let _project = suite_lifecycle::project_guard(&project).await;
            // 获取锁后再次检查，避免与卸载完成后的旧扫描结果竞争。
            let exists: bool = sqlx::query_scalar(
                "SELECT EXISTS(SELECT 1 FROM docker_compose_projects WHERE name=?)",
            )
            .bind(&project)
            .fetch_one(&state.metadata_db)
            .await?;
            if !exists {
                return Ok(());
            }
            if read_suite_metadata(&project).await?.agent_access.is_none() {
                return Ok(());
            }
            apply_managed_suite(state, &project).await
        }
        .await;
        match result {
            Ok(()) => {
                retries.remove(&project);
            }
            Err(error) => {
                let delay = retries
                    .get(&project)
                    .map_or(5, |(_, delay)| (*delay * 2).min(60));
                let message = error.to_string();
                // 仅首次失败或错误变化时打印，后续状态通过数据库可查。
                if !retries.contains_key(&project) || previous.as_deref() != Some(&message) {
                    tracing::warn!(project, error = %message, retry_seconds = delay, "Suite reconciliation failed");
                }
                retries.insert(
                    project,
                    (Instant::now() + Duration::from_secs(delay), delay),
                );
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod lifecycle_tests {
    use super::*;

    /// 一个项目中的非授权服务也必须禁止 Docker 自行启动；挂载必须禁止自动建目录。
    #[tokio::test]
    async fn runtime_override_covers_entire_project_and_mounts_directory() {
        let dir = std::env::temp_dir().join(format!("veydeck-override-{}", Uuid::new_v4()));
        tokio::fs::create_dir_all(&dir).await.unwrap();
        tokio::fs::write(
            dir.join(COMPOSE_FILE_NAME),
            "services:\n  app:\n    image: test\n  db:\n    image: test-db\n",
        )
        .await
        .unwrap();
        let payload: SuiteInstallRequest = serde_json::from_value(json!({
            "instanceId":"i", "suiteId":"s", "version":"1", "composeProjectName":"p",
            "composeFile":"compose.yaml", "files":[], "appEntries":[]
        }))
        .unwrap();
        let access = SuiteAgentAccess {
            services: vec!["app".into()],
            capabilities: vec!["workloads.manage".into()],
        };
        write_suite_runtime_override(
            &dir,
            &dir.join("runtime"),
            &payload,
            &access,
            CommandTransport::Uds,
        )
        .await
        .unwrap();
        let output: Value = serde_json::from_slice(
            &tokio::fs::read(dir.join(SUITE_RUNTIME_OVERRIDE_FILE))
                .await
                .unwrap(),
        )
        .unwrap();
        assert_eq!(output["services"]["app"]["restart"], "no");
        assert_eq!(output["services"]["db"]["restart"], "no");
        let mounts = output["services"]["app"]["volumes"].as_array().unwrap();
        assert_eq!(mounts[1]["target"], "/run/veydeck-agent-socket");
        assert_eq!(
            mounts[1]["source"],
            json!(
                veydeck_contracts::types::agent_socket_path()
                    .parent()
                    .unwrap()
            )
        );
        for mount in mounts {
            assert_eq!(mount["read_only"], true);
            assert_eq!(mount["bind"]["create_host_path"], false);
        }
        write_suite_runtime_override(
            &dir,
            &dir.join("runtime"),
            &payload,
            &access,
            CommandTransport::Https,
        )
        .await
        .unwrap();
        let output: Value = serde_json::from_slice(
            &tokio::fs::read(dir.join(SUITE_RUNTIME_OVERRIDE_FILE))
                .await
                .unwrap(),
        )
        .unwrap();
        assert_eq!(
            output["services"]["app"]["volumes"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        assert!(output["services"]["db"].get("volumes").is_none());
        tokio::fs::remove_dir_all(dir).await.unwrap();
    }

    /// 意图独立于执行错误，卸载项目后自动清理对应恢复记录。
    #[tokio::test]
    async fn desired_state_survives_errors_and_is_removed_with_project() {
        let state = Arc::new(crate::test_support::setup_test_state().await);
        sqlx::query("INSERT INTO docker_compose_projects (name, compose_dir, management_kind) VALUES ('p', '/tmp/p', 'suite')")
            .execute(&state.metadata_db).await.unwrap();
        assert!(set_desired_state(&state, "p", true).await.is_err());
        sqlx::query("INSERT INTO suite_lifecycle (project_name) VALUES ('p')")
            .execute(&state.metadata_db).await.unwrap();
        set_desired_state(&state, "p", true).await.unwrap();
        let result = apply_managed_suite(&state, "p").await;
        assert!(result.is_err());
        let (desired, error): (String, Option<String>) = sqlx::query_as(
            "SELECT desired_state, last_error FROM suite_lifecycle WHERE project_name='p'",
        )
        .fetch_one(&state.metadata_db)
        .await
        .unwrap();
        assert_eq!(desired, "enabled");
        assert!(error.is_some());
        set_desired_state(&state, "p", false).await.unwrap();
        let desired: String =
            sqlx::query_scalar("SELECT desired_state FROM suite_lifecycle WHERE project_name='p'")
                .fetch_one(&state.metadata_db)
                .await
                .unwrap();
        assert_eq!(desired, "disabled");
        sqlx::query("DELETE FROM docker_compose_projects WHERE name='p'")
            .execute(&state.metadata_db)
            .await
            .unwrap();
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM suite_lifecycle")
            .fetch_one(&state.metadata_db)
            .await
            .unwrap();
        assert_eq!(count, 0);
    }

    /// 排队的启用操作不能越过同项目的卸载或停用操作。
    #[tokio::test]
    async fn lifecycle_actions_are_serialized_per_project() {
        let project = format!("p-{}", Uuid::new_v4());
        let guard = suite_lifecycle::project_guard(&project).await;
        assert!(
            timeout(
                Duration::from_millis(25),
                suite_lifecycle::project_guard(&project)
            )
            .await
            .is_err()
        );
        assert!(
            timeout(
                Duration::from_millis(25),
                suite_lifecycle::project_guard("other-project")
            )
            .await
            .is_ok()
        );
        drop(guard);
        assert!(
            timeout(
                Duration::from_millis(25),
                suite_lifecycle::project_guard(&project)
            )
            .await
            .is_ok()
        );
    }
}

#[cfg(test)]
mod docker_lifecycle_tests {
    use super::*;
    use tokio::io::{AsyncBufReadExt, BufReader};

    /// 即使断言失败也只回收本测试创建的 Compose 项目。
    struct TestProjectCleanup {
        project: String,
        dir: PathBuf,
    }
    impl Drop for TestProjectCleanup {
        fn drop(&mut self) {
            let _ = std::process::Command::new("docker")
                .arg("compose")
                .arg("-f")
                .arg(self.dir.join(COMPOSE_FILE_NAME))
                .arg("-f")
                .arg(self.dir.join(SUITE_RUNTIME_OVERRIDE_FILE))
                .args(["-p", &self.project, "down", "--remove-orphans"])
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status();
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    /// 显式运行的真实 Docker/packet SDK 验证；使用独立的临时开发目录，不接触已有套件。
    #[tokio::test]
    #[ignore = "requires Docker, packet image and isolated VEYDECK_DEV_HOME"]
    async fn real_packet_sdk_reconnects_after_socket_replacement() {
        let home = PathBuf::from(
            std::env::var("VEYDECK_DEV_HOME").expect("set isolated VEYDECK_DEV_HOME"),
        );
        assert!(home.starts_with(std::env::temp_dir()));
        tokio::fs::create_dir_all(&home).await.unwrap();
        tokio::fs::write(
            home.join("runtime-listen.json"),
            r#"{"host":"127.0.0.1","port":19999}"#,
        )
        .await
        .unwrap();
        let state = Arc::new(crate::test_support::setup_test_state().await);
        ensure_suite_network(&state).await.unwrap();
        let socket = veydeck_contracts::types::agent_socket_path();
        tokio::fs::create_dir_all(socket.parent().unwrap())
            .await
            .unwrap();
        let app = axum::Router::new().nest(
            "/api/v1/agent",
            crate::routes::state_api_router(state.clone()),
        );
        suite_lifecycle::prepare_socket(&socket).await.unwrap();
        let listener = tokio::net::UnixListener::bind(&socket).unwrap();
        let (stop_tx, stop_rx) = tokio::sync::oneshot::channel();
        let app_first = app.clone();
        let server = tokio::spawn(async move {
            axum::serve(listener, app_first)
                .with_graceful_shutdown(async {
                    let _ = stop_rx.await;
                })
                .await
                .unwrap();
        });
        let project = format!("veydeck-lifecycle-test-{}", Uuid::new_v4().simple());
        let compose = "services:\n  packet:\n    image: veydeck/packet:0.1.0-alpha.1\n    restart: unless-stopped\n";
        let payload = SuiteInstallRequest {
            adopt_retained_data: false,
            resources: None,
            instance_id: Uuid::new_v4().to_string(),
            suite_id: "veydeck.lifecycle-test".into(),
            version: "1".into(),
            compose_project_name: project.clone(),
            compose_file: COMPOSE_FILE_NAME.into(),
            runtime_images: Vec::new(),
            agent_access: Some(SuiteAgentAccess {
                services: vec!["packet".into()],
                capabilities: vec!["operation-logs.write".into()],
            }),
            files: vec![SuitePackageFile {
                path: COMPOSE_FILE_NAME.into(),
                content_base64: STANDARD.encode(compose),
            }],
            app_entries: Vec::new(),
        };
        let dir = suite_project_dir(&project);
        install_suite_inner(&state, &payload, &dir).await.unwrap();
        let _cleanup = TestProjectCleanup {
            project: project.clone(),
            dir: dir.clone(),
        };
        // 安装后保持停用；Master 不在线也按本地持久化意图恢复。
        let initial: String = sqlx::query_scalar("SELECT desired_state FROM suite_lifecycle WHERE project_name=?")
            .bind(&project).fetch_one(&state.metadata_db).await.unwrap();
        assert_eq!(initial, "disabled");
        assert!(compose_output(&project, &dir.join(COMPOSE_FILE_NAME), &["ps", "--all", "--quiet"]).await.unwrap().is_empty());
        set_desired_state(&state, &project, true).await.unwrap();
        apply_managed_suite(&state, &project).await.unwrap();
        let file = dir.join(COMPOSE_FILE_NAME);
        let ids = compose_output(&project, &file, &["ps", "--quiet"])
            .await
            .unwrap();
        let id = String::from_utf8_lossy(&ids).trim().to_string();
        assert!(!id.is_empty());
        let policy = Command::new("docker")
            .args([
                "inspect",
                "--format",
                "{{.HostConfig.RestartPolicy.Name}}",
                &id,
            ])
            .output()
            .await
            .unwrap();
        assert_eq!(String::from_utf8_lossy(&policy.stdout).trim(), "no");
        let token = tokio::fs::read(dir.join("runtime/access-token"))
            .await
            .unwrap();
        let script = r#"
import asyncio,uuid
from pathlib import Path
from veydeck_suite_runtime.client import RuntimeClient
async def main():
    client=await RuntimeClient.from_environment('operation-logs.write')
    async def emit():
        await client.request('POST','/api/v1/agent/suite-runtime/operation-events',json={
          'eventId':'019a80c0-0000-7000-8000-000000000001','eventCode':'reconnect_test',
          'eventLabel':{'zhCn':'连接测试','enUs':'Connection test'},'outcome':'success','impact':'info','parameters':{}})
    async def phase(n):
        while not Path('/run/veydeck-agent/e2e-phase').exists() or Path('/run/veydeck-agent/e2e-phase').read_text()!=str(n):
            await asyncio.sleep(0.05)
    await emit()
    print('connected',flush=True)
    await phase(1)
    try:
        await emit()
        raise AssertionError('Agent should be unavailable')
    except Exception as error:
        if isinstance(error,AssertionError): raise
        print('unavailable',flush=True)
    await phase(2)
    await emit()
    print('reconnected',flush=True)
asyncio.run(main())
"#;
        let mut sdk = Command::new("docker")
            .kill_on_drop(true)
            .args(["exec", &id, "python", "-u", "-c", script])
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::inherit())
            .spawn()
            .unwrap();
        let mut lines = BufReader::new(sdk.stdout.take().unwrap()).lines();
        assert_eq!(
            timeout(Duration::from_secs(20), lines.next_line())
                .await
                .unwrap()
                .unwrap()
                .as_deref(),
            Some("connected")
        );
        stop_tx.send(()).unwrap();
        timeout(Duration::from_secs(5), server)
            .await
            .unwrap()
            .unwrap();
        suite_lifecycle::prepare_socket(&socket).await.unwrap();
        tokio::fs::write(dir.join("runtime/e2e-phase"), "1")
            .await
            .unwrap();
        assert_eq!(
            timeout(Duration::from_secs(10), lines.next_line())
                .await
                .unwrap()
                .unwrap()
                .as_deref(),
            Some("unavailable")
        );
        suite_lifecycle::prepare_socket(&socket).await.unwrap();
        let listener = tokio::net::UnixListener::bind(&socket).unwrap();
        let (stop_tx, stop_rx) = tokio::sync::oneshot::channel();
        let server = tokio::spawn(async move {
            axum::serve(listener, app)
                .with_graceful_shutdown(async {
                    let _ = stop_rx.await;
                })
                .await
                .unwrap();
        });
        tokio::fs::write(dir.join("runtime/e2e-phase"), "2")
            .await
            .unwrap();
        assert_eq!(
            timeout(Duration::from_secs(10), lines.next_line())
                .await
                .unwrap()
                .unwrap()
                .as_deref(),
            Some("reconnected")
        );
        assert!(sdk.wait().await.unwrap().success());
        assert_eq!(
            tokio::fs::read(dir.join("runtime/access-token"))
                .await
                .unwrap(),
            token
        );
        let after = compose_output(&project, &file, &["ps", "--quiet"])
            .await
            .unwrap();
        assert_eq!(
            ids, after,
            "Agent restart must not recreate packet container"
        );
        set_desired_state(&state, &project, false).await.unwrap();
        apply_managed_suite(&state, &project).await.unwrap();
        apply_managed_suite(&state, &project).await.unwrap();
        let ps = compose_output(&project, &file, &["ps", "--all", "--format", "json"])
            .await
            .unwrap();
        assert!(
            parse_compose_ps(&ps)
                .unwrap()
                .iter()
                .all(|row| row["State"] != "running")
        );
        run_compose_command(&project, &file, &["down"])
            .await
            .unwrap();
        stop_tx.send(()).unwrap();
        timeout(Duration::from_secs(5), server)
            .await
            .unwrap()
            .unwrap();
        tokio::fs::remove_dir_all(&dir).await.unwrap();
        let _ = tokio::fs::remove_file(socket).await;
    }
}
