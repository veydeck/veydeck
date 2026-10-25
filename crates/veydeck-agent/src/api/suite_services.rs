//! 平台分配的套件业务目录与实例范围内的固定 Nginx 控制操作。
use crate::{
    api::docker::suites,
    config,
    state::AppState,
    types::{ApiError, ApiResponse, ApiResult},
};
use axum::{
    Json, Router,
    extract::{Path, State},
    http::HeaderMap,
    response::IntoResponse,
    routing::post,
};
use base64::Engine;
use ring::rand::{SecureRandom, SystemRandom};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{
    path::{Path as FsPath, PathBuf},
    sync::Arc,
    time::Duration,
};
use tokio::process::Command;

/// 串行执行业务数据接管与删除，避免生命周期操作交叉。
static RESOURCE_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// 平台分配目录的归属记录在卸载后保留，重装需明确接管。
#[derive(Serialize, Deserialize)]
struct Owner {
    suite_id: String,
    instance_id: String,
    project: String,
}

/// 受限引擎操作参数；发布版本只能是 UUID。
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ControlRequest {
    revision: Option<String>,
}

/// 生产目录沿用平台 home，开发目录使用同一布局。
fn data_root() -> PathBuf {
    config::suite_resource_root_dir()
}

/// 校验声明并创建宿主机目录，写入 Compose 专用环境和凭据。
pub(crate) async fn prepare_resources(
    payload: &suites::SuiteInstallRequest,
    dir: &FsPath,
) -> ApiResult<()> {
    let _guard = RESOURCE_LOCK.lock().await;
    let Some(resources) = &payload.resources else {
        return Ok(());
    };
    resources
        .validate()
        .map_err(|e| ApiError::BadRequest(e.into()))?;
    uuid::Uuid::parse_str(&payload.instance_id)
        .map_err(|_| ApiError::BadRequest("resource instance ID must be UUID".into()))?;
    if !payload.agent_access.as_ref().is_some_and(|a| {
        a.services.contains(&resources.manager_service)
            && a.capabilities.iter().any(|c| c == "services.control")
    }) {
        return Err(ApiError::BadRequest(
            "resource manager must declare services.control".into(),
        ));
    }
    let root = resource_directory(&data_root(), &payload.suite_id)?;
    if let Some(owner) = prepare_resource_directory(&root).await? {
        validate_owner(&owner)?;
        if owner.suite_id != payload.suite_id || owner.instance_id != payload.instance_id {
            require_resource_adoption(
                &owner.suite_id,
                &payload.suite_id,
                retained_project_is_present(&suites::suite_project_dir(&owner.project), dir),
                payload.adopt_retained_data,
            )?;
            let old = root.join("instances").join(&owner.instance_id);
            let new = root.join("instances").join(&payload.instance_id);
            if old.exists() {
                tokio::fs::rename(old, new).await?;
            }
        }
    }

    let owner = Owner {
        suite_id: payload.suite_id.clone(),
        instance_id: payload.instance_id.clone(),
        project: payload.compose_project_name.clone(),
    };
    tokio::fs::write(
        root.join(".owner.json"),
        serde_json::to_vec(&owner).map_err(|e| ApiError::BadRequest(e.to_string()))?,
    )
    .await?;
    tokio::fs::write(
        dir.join(".env"),
        format!(
            "VEYDECK_SUITE_DATA_DIR={}\nVEYDECK_SUITE_INSTANCE_ID={}\n",
            root.display(),
            payload.instance_id
        ),
    )
    .await?;
    let mut random = [0; 32];
    SystemRandom::new()
        .fill(&mut random)
        .map_err(|_| ApiError::Internal("cannot generate entry credential".into()))?;
    let token = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(random);
    tokio::fs::write(dir.join("entry-token"), &token).await?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        tokio::fs::set_permissions(
            dir.join("entry-token"),
            std::fs::Permissions::from_mode(0o600),
        )
        .await?;
    }
    let mount = format!(
        "{}:/run/veydeck-entry-token:ro",
        dir.join("entry-token").display()
    );
    let overlay = json!({"services": {&resources.manager_service: {"volumes": [mount], "environment": {"VEYDECK_ENTRY_TOKEN_FILE":"/run/veydeck-entry-token", "VEYDECK_SUITE_INSTANCE_ID":payload.instance_id, "VEYDECK_HOST_DATA_DIR":root.to_string_lossy()}}}});
    tokio::fs::write(
        dir.join("compose.resources.yaml"),
        serde_json::to_vec(&overlay).map_err(|e| ApiError::BadRequest(e.to_string()))?,
    )
    .await?;
    Ok(())
}

/// 只能解析平台预先分配的目录，输入不会作为路径组件拼接。
fn resource_directory(base: &FsPath, suite: &str) -> ApiResult<PathBuf> {
    let directory = veydeck_contracts::suite_resources::SuiteResources::data_directory(suite)
        .map_err(|error| ApiError::BadRequest(error.into()))?;
    Ok(base.join(directory))
}

/// 创建平台分配目录；已有非空目录必须携带可读取的归属记录。
async fn prepare_resource_directory(root: &FsPath) -> ApiResult<Option<Owner>> {
    check_resource_path(root).await?;
    tokio::fs::create_dir_all(root).await?;
    let owner = read_owner(root).await?;
    if owner.is_none()
        && tokio::fs::read_dir(root)
            .await?
            .next_entry()
            .await?
            .is_some()
    {
        return Err(ApiError::BadRequest(
            "refusing to claim a non-empty directory without suite ownership".into(),
        ));
    }
    Ok(owner)
}

/// 拒绝专用根目录、套件目录和归属文件的符号链接。
async fn check_resource_path(root: &FsPath) -> ApiResult<()> {
    for path in [
        root.parent().unwrap_or(root).to_path_buf(),
        root.to_path_buf(),
        root.join("instances"),
        root.join(".owner.json"),
    ] {
        match tokio::fs::symlink_metadata(&path).await {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err(ApiError::BadRequest(
                    "suite resource paths cannot be symbolic links".into(),
                ));
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
    }
    Ok(())
}

/// 读取归属；只有文件不存在才视为尚未分配，损坏或不可读时拒绝操作。
async fn read_owner(root: &FsPath) -> ApiResult<Option<Owner>> {
    match tokio::fs::read(root.join(".owner.json")).await {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map(Some)
            .map_err(|error| ApiError::BadRequest(error.to_string())),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.into()),
    }
}

/// 归属文件中的实例和项目名必须安全，防止接管时跨目录访问。
fn validate_owner(owner: &Owner) -> ApiResult<()> {
    uuid::Uuid::parse_str(&owner.instance_id)
        .map_err(|_| ApiError::BadRequest("invalid resource owner instance ID".into()))?;
    if owner.project.is_empty()
        || !owner.project.bytes().all(|value| {
            value.is_ascii_lowercase() || value.is_ascii_digit() || matches!(value, b'-' | b'_')
        })
    {
        return Err(ApiError::BadRequest(
            "invalid resource owner project".into(),
        ));
    }
    Ok(())
}

/// 只删除平台分配且归属三元组完全一致的业务目录。
async fn remove_owned_directory(
    root: &FsPath,
    project: &str,
    instance: &str,
    suite: &str,
) -> ApiResult<()> {
    check_resource_path(root).await?;
    if let Some(owner) = read_owner(root).await? {
        validate_owner(&owner)?;
        if owner.project == project && owner.instance_id == instance && owner.suite_id == suite {
            tokio::fs::remove_dir_all(root).await?;
        }
    }
    Ok(())
}

/// 区分仍被占用的数据与需要显式接管的保留数据。
fn require_resource_adoption(
    owner_suite: &str,
    installing_suite: &str,
    project_present: bool,
    adopt: bool,
) -> ApiResult<()> {
    use veydeck_contracts::api::ErrorCode;
    if owner_suite != installing_suite || project_present {
        return Err(ApiError::conflict(
            ErrorCode::SuiteResourceInUse,
            "Suite data is in use by another instance. Uninstall that instance first.",
        ));
    }
    if !adopt {
        return Err(ApiError::conflict(
            ErrorCode::SuiteRetainedDataRequiresAdoption,
            "Retained suite data was found. Select 'Adopt previously retained suite data' and install again.",
        ));
    }
    Ok(())
}

/// 安装入口已确认目标部署目录不存在；同路径的新目录属于本次安装。
/// 其他项目目录或已写入实例元数据的目录仍视为现有部署。
fn retained_project_is_present(owner_dir: &FsPath, installing_dir: &FsPath) -> bool {
    if owner_dir == installing_dir {
        owner_dir.join("suite-agent.json").exists()
    } else {
        owner_dir.exists()
    }
}

/// 显式删除业务数据时先核对持久化归属，默认保留。
pub(crate) async fn remove_resources(
    project: &str,
    instance: &str,
    suite: &str,
    remove: bool,
) -> ApiResult<()> {
    if !remove {
        return Ok(());
    }
    let _guard = RESOURCE_LOCK.lock().await;
    // 普通套件没有平台分配的业务目录，只由 Compose 管理其数据卷。
    if veydeck_contracts::suite_resources::SuiteResources::data_directory(suite).is_err() {
        return Ok(());
    }
    let root = resource_directory(&data_root(), suite)?;
    remove_owned_directory(&root, project, instance, suite).await?;
    Ok(())
}

/// 只有实例令牌可调用的固定动作，不接收命令或容器标识。
pub fn router() -> Router<Arc<AppState>> {
    Router::new().route("/suite-runtime/services/{action}", post(control))
}

/// 认证实例主体，按声明服务定位唯一引擎。
async fn control(
    State(_state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(action): Path<String>,
    Json(request): Json<ControlRequest>,
) -> ApiResult<impl IntoResponse> {
    let token = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.strip_prefix("Bearer "))
        .unwrap_or("");
    let principal = suites::authenticate_suite_runtime(token).await?;
    if !principal
        .capabilities
        .iter()
        .any(|c| c == "services.control")
    {
        return Err(ApiError::forbidden(
            veydeck_contracts::api::ErrorCode::AuthForbidden,
            "services.control is required",
        ));
    }
    let mut dirs = tokio::fs::read_dir(config::compose_root_dir().join("suite")).await?;
    let mut found = None;
    while let Some(dir) = dirs.next_entry().await? {
        let project = dir.file_name().to_string_lossy().into_owned();
        if let Ok(metadata) = suites::read_suite_metadata(&project).await
            && metadata.instance_id == principal.instance_id
            && metadata.suite_id == principal.suite_id
        {
            found = Some(metadata);
            break;
        }
    }
    let metadata = found.ok_or_else(|| ApiError::BadRequest("suite instance not found".into()))?;
    let resources = metadata
        .resources
        .ok_or_else(|| ApiError::BadRequest("controlled engine is not declared".into()))?;
    resources
        .validate()
        .map_err(|e| ApiError::BadRequest(e.into()))?;
    let mut args = service_arguments(&action, request.revision.as_deref(), &principal.instance_id)?;
    let id = docker_output(&[
        "ps".into(),
        "--filter".into(),
        format!(
            "label=com.docker.compose.project={}",
            metadata.compose_project_name
        ),
        "--filter".into(),
        format!(
            "label=com.docker.compose.service={}",
            resources.engine_service
        ),
        "--format".into(),
        "{{.ID}}".into(),
    ])
    .await?;
    let ids: Vec<_> = id.split_whitespace().collect();
    if ids.len() != 1 {
        return Err(ApiError::BadRequest(
            "exactly one running engine is required".into(),
        ));
    }
    let mut command = vec!["exec".into(), ids[0].into()];
    command.append(&mut args);
    let output = docker_output(&command).await?;
    Ok(ApiResponse::success_with_raw(
        "Service action completed",
        Some(json!({"output":output})),
    ))
}

/// 执行固定参数的 Docker 操作，并限制等待时间和返回文本。
async fn docker_output(args: &[String]) -> ApiResult<String> {
    let mut command = Command::new("docker");
    command.args(args).kill_on_drop(true);
    let output = tokio::time::timeout(Duration::from_secs(30), command.output())
        .await
        .map_err(|_| ApiError::BadRequest("service action timed out".into()))??;
    let text = format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let text: String = text.chars().take(8192).collect();
    if !output.status.success() {
        return Err(ApiError::BadRequest(text));
    }
    Ok(text)
}

/// 固定动作与版本参数映射，不允许调用方提供命令或路径。
fn service_arguments(
    action: &str,
    revision: Option<&str>,
    instance: &str,
) -> ApiResult<Vec<String>> {
    let args = match action {
        "validate" => vec![
            "/usr/sbin/nginx".to_string(),
            "-t".into(),
            "-c".into(),
            format!(
                "/data/instances/{}/releases/{}/nginx.conf",
                instance,
                revision
                    .and_then(|v| uuid::Uuid::parse_str(v).ok())
                    .ok_or_else(|| ApiError::BadRequest("revision is required".into()))?
            ),
        ],
        "reload" => vec![
            "/usr/sbin/nginx".into(),
            "-s".into(),
            "reload".into(),
            "-c".into(),
            format!("/data/instances/{}/current/nginx.conf", instance),
        ],
        "reopen" => vec![
            "/usr/sbin/nginx".into(),
            "-s".into(),
            "reopen".into(),
            "-c".into(),
            format!("/data/instances/{}/current/nginx.conf", instance),
        ],
        "status" => vec!["/usr/sbin/nginx".into(), "-v".into()],
        _ => return Err(ApiError::BadRequest("unknown service action".into())),
    };
    Ok(args)
}

#[cfg(test)]
mod tests {
    use super::*;
    /// 业务目录删除只影响匹配归属的网站数据，Compose 项目保持完整。
    #[tokio::test]
    async fn resource_cleanup_is_isolated_from_compose_projects() {
        let base = std::env::temp_dir().join(format!("veydeck-resource-{}", uuid::Uuid::now_v7()));
        let compose = base.join("compose/suite/project/compose.yaml");
        tokio::fs::create_dir_all(compose.parent().unwrap())
            .await
            .unwrap();
        tokio::fs::write(&compose, "services: {}").await.unwrap();
        let root = resource_directory(&base.join("www"), "veydeck.websites").unwrap();
        assert!(prepare_resource_directory(&root).await.unwrap().is_none());
        let instance = uuid::Uuid::now_v7().to_string();
        let owner = Owner {
            suite_id: "veydeck.websites".into(),
            instance_id: instance.clone(),
            project: "veydeck-websites".into(),
        };
        tokio::fs::write(
            root.join(".owner.json"),
            serde_json::to_vec(&owner).unwrap(),
        )
        .await
        .unwrap();
        tokio::fs::write(root.join("content"), "website data")
            .await
            .unwrap();
        remove_owned_directory(&root, "other", &instance, "veydeck.websites")
            .await
            .unwrap();
        assert!(root.join("content").exists());
        remove_owned_directory(&root, "veydeck-websites", &instance, "veydeck.websites")
            .await
            .unwrap();
        assert!(!root.exists());
        assert_eq!(
            tokio::fs::read_to_string(&compose).await.unwrap(),
            "services: {}"
        );
        assert!(resource_directory(&base.join("www"), "compose").is_err());
        tokio::fs::remove_dir_all(base).await.unwrap();
    }

    /// 不覆盖无归属数据，不允许通过根目录、子目录或归属链接认领外部文件。
    #[tokio::test]
    async fn resource_claim_rejects_unowned_content_and_symbolic_links() {
        let base =
            std::env::temp_dir().join(format!("veydeck-resource-links-{}", uuid::Uuid::now_v7()));
        let www = base.join("www");
        let root = www.join("websites");
        let outside = base.join("compose");
        tokio::fs::create_dir_all(&outside).await.unwrap();
        tokio::fs::write(outside.join("compose.yaml"), "keep")
            .await
            .unwrap();
        tokio::fs::create_dir_all(&root).await.unwrap();
        tokio::fs::write(root.join("content"), "unowned")
            .await
            .unwrap();
        assert!(prepare_resource_directory(&root).await.is_err());
        assert_eq!(
            tokio::fs::read_to_string(root.join("content"))
                .await
                .unwrap(),
            "unowned"
        );
        tokio::fs::remove_dir_all(&www).await.unwrap();
        std::os::unix::fs::symlink(&outside, &www).unwrap();
        assert!(prepare_resource_directory(&root).await.is_err());
        assert!(
            remove_owned_directory(&root, "project", "instance", "veydeck.websites")
                .await
                .is_err()
        );
        tokio::fs::remove_file(&www).await.unwrap();
        tokio::fs::create_dir_all(&www).await.unwrap();
        std::os::unix::fs::symlink(&outside, &root).unwrap();
        assert!(prepare_resource_directory(&root).await.is_err());
        tokio::fs::remove_file(&root).await.unwrap();
        tokio::fs::create_dir_all(&root).await.unwrap();
        std::os::unix::fs::symlink(outside.join("compose.yaml"), root.join(".owner.json")).unwrap();
        assert!(prepare_resource_directory(&root).await.is_err());
        assert_eq!(
            tokio::fs::read_to_string(outside.join("compose.yaml"))
                .await
                .unwrap(),
            "keep"
        );
        tokio::fs::remove_dir_all(base).await.unwrap();
    }

    /// 只有可接管的保留数据提示勾选接管，占用冲突始终要求释放旧实例。
    #[test]
    fn resource_conflicts_return_actionable_error_codes() {
        use veydeck_contracts::api::ErrorCode;
        let error = require_resource_adoption("websites", "websites", false, false).unwrap_err();
        assert_eq!(error.code, ErrorCode::SuiteRetainedDataRequiresAdoption);
        assert!(error.message.contains("Select"));
        assert!(require_resource_adoption("websites", "websites", false, true).is_ok());
        for adopt in [false, true] {
            let error = require_resource_adoption("websites", "websites", true, adopt).unwrap_err();
            assert_eq!(error.code, ErrorCode::SuiteResourceInUse);
            let error = require_resource_adoption("other", "websites", false, adopt).unwrap_err();
            assert_eq!(error.code, ErrorCode::SuiteResourceInUse);
        }
    }

    /// 保留数据重装时，新建的同名项目目录不能被误认为旧实例。
    #[test]
    fn retained_data_accepts_new_install_directory_but_rejects_existing_deployments() {
        let root = std::env::temp_dir().join(format!("veydeck-retained-{}", uuid::Uuid::now_v7()));
        let installing = root.join("veydeck-websites");
        let other = root.join("other-project");
        std::fs::create_dir_all(&installing).unwrap();
        std::fs::write(installing.join("compose.yaml"), "services: {}").unwrap();
        assert!(!retained_project_is_present(&installing, &installing));
        assert!(!retained_project_is_present(&other, &installing));

        std::fs::create_dir_all(&other).unwrap();
        assert!(retained_project_is_present(&other, &installing));
        std::fs::write(installing.join("suite-agent.json"), "{}").unwrap();
        assert!(retained_project_is_present(&installing, &installing));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn only_fixed_engine_actions_and_uuid_revisions_are_allowed() {
        let id = "00000000-0000-0000-0000-000000000001";
        assert!(service_arguments("exec", None, id).is_err());
        assert!(service_arguments("validate", Some("../../etc/passwd"), id).is_err());
        assert!(service_arguments("validate", None, id).is_err());
        let args = service_arguments("validate", Some(id), id).unwrap();
        assert_eq!(args[0], "/usr/sbin/nginx");
        assert!(
            args.last()
                .unwrap()
                .ends_with("/releases/00000000-0000-0000-0000-000000000001/nginx.conf")
        );
        let args = service_arguments("reload", None, id).unwrap();
        assert_eq!(&args[1..3], ["-s", "reload"]);
    }
}
