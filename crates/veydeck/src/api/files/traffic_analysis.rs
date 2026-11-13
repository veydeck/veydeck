//! 将节点上的抓包文件作为独立副本导入同节点流量解析实例。

use super::*;
use crate::models::{
    apps::{AppSummary, list_apps},
    suites::{SuiteInstanceSummary, fetch_instance_by_suite_and_node},
};
use axum::body::{Bytes, to_bytes};
use futures_util::StreamExt;
use serde::Serialize;
use std::io;
use veydeck_contracts::files::{FileEntryKind, FileTransferDirection};

const SUITE_ID: &str = "veydeck.packet";
const MAX_CAPTURE_BYTES: u64 = 100 * 1024 * 1024;

/// 仅接受源路径，不允许调用方选择其他节点或套件目标。
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct SendRequest {
    path: String,
}

/// 导入结果包含同节点应用入口，前端无需借用全局节点应用缓存。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SendResult {
    app: AppSummary,
    import_id: String,
}

/// 请求取消或失败时也释放下载传输，已完成的传输保持原有终态。
struct TransferCleanup {
    client: NodeRuntimeClient,
    context: AgentOperationContext,
    id: String,
}

impl Drop for TransferCleanup {
    fn drop(&mut self) {
        let client = self.client.clone();
        let context = self.context.clone();
        let path = format!("{AGENT_BASE_PATH}/transfer/{}/cancel", self.id);
        tokio::spawn(async move {
            let _ = client
                .post_domain_with_operation_context::<FileTransfer, _>(&path, &json!({}), &context)
                .await;
        });
    }
}

/// 检查普通文件、可读权限、扩展名及套件上传大小上限。
fn validate_capture(detail: &FileEntryDetail) -> ApiResult<()> {
    let entry = &detail.summary;
    let extension = std::path::Path::new(&entry.name)
        .extension()
        .and_then(|value| value.to_str());
    if entry.kind != FileEntryKind::File
        || !extension.is_some_and(|value| {
            value.eq_ignore_ascii_case("pcap") || value.eq_ignore_ascii_case("pcapng")
        })
    {
        return Err(ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            ErrorCode::FileTypeUnsupported,
            "Only regular .pcap and .pcapng files can be sent",
        ));
    }
    if !entry.capabilities.can_read {
        return Err(ApiError::forbidden(
            ErrorCode::FilePermissionDenied,
            "File is not readable",
        ));
    }
    if entry.size_bytes.is_none_or(|size| size > MAX_CAPTURE_BYTES) {
        return Err(ApiError::new(
            StatusCode::PAYLOAD_TOO_LARGE,
            ErrorCode::ValidationFailed,
            "Traffic analysis accepts files up to 100 MiB",
        )
        .with_message_key("fileBrowser.trafficCaptureTooLarge"));
    }
    Ok(())
}

/// 在写入 multipart 结束标记前核对长度和源文件版本，变化时中断导入。
async fn verify_source(
    client: &NodeRuntimeClient,
    path: &str,
    revision: &str,
    size: u64,
) -> ApiResult<()> {
    let detail: FileEntryDetail = client.get_domain(path).await?;
    if detail.summary.kind != FileEntryKind::File
        || detail.summary.revision != revision
        || detail.summary.size_bytes != Some(size)
    {
        return Err(ApiError::conflict(
            ErrorCode::FileChanged,
            "Capture file changed while sending",
        ));
    }
    Ok(())
}

/// 流式传输时检查实际长度，验证成功后才允许套件收到完整表单。
fn capture_multipart_body(
    source: Body,
    size: u64,
    start: Bytes,
    end: Bytes,
    verify: impl std::future::Future<Output = ApiResult<()>> + Send + 'static,
) -> Body {
    let chunks = futures_util::stream::try_unfold(
        (source.into_data_stream(), 0_u64, Some(verify), end),
        move |(mut stream, received, verify, end)| async move {
            let Some(verify) = verify else {
                return Ok(None);
            };
            if let Some(chunk) = stream.next().await {
                let chunk = chunk.map_err(io::Error::other)?;
                let total = received + chunk.len() as u64;
                if total > size || total > MAX_CAPTURE_BYTES {
                    return Err(io::Error::other("Capture file exceeded expected size"));
                }
                return Ok(Some((chunk, (stream, total, Some(verify), end))));
            }
            if received != size {
                return Err(io::Error::other("Capture file was truncated"));
            }
            verify
                .await
                .map_err(|error| io::Error::other(error.to_string()))?;
            Ok(Some((end, (stream, received, None, Bytes::new()))))
        },
    );
    Body::from_stream(futures_util::stream::once(async { Ok::<_, io::Error>(start) }).chain(chunks))
}

/// 仅从源节点下载并上传至该节点实例；客户端从未接触文件内容。
pub(super) async fn send(
    State(state): State<Arc<AppState>>,
    Path(node_id): Path<String>,
    admin: AuthenticatedAdmin,
    headers: HeaderMap,
    Json(request): Json<SendRequest>,
) -> ApiResult<Response> {
    let result = send_capture(&state, &node_id, &admin, &headers, &request.path).await;
    record_sync_operation(
        &state,
        &admin,
        &headers,
        &node_id,
        SyncOperationLog {
            event: "file_send_to_traffic_analysis",
            method: "POST",
            target: &request.path,
            high_impact: false,
            durability: None,
        },
        &result,
    );
    Ok(ApiResponse::success_with_raw("Capture imported", Some(result?)).into_response())
}

/// 仅从指定节点解析已启用实例及入口，不使用其他节点的安装作为后备。
async fn resolve_target(
    pool: &crate::state::DbPool,
    node_id: &str,
    locale: Option<&str>,
) -> ApiResult<(SuiteInstanceSummary, AppSummary)> {
    let instance = fetch_instance_by_suite_and_node(pool, SUITE_ID, node_id)
        .await?
        .ok_or_else(|| {
            ApiError::validation("Traffic analysis is not installed on this node")
                .with_message_key("fileBrowser.trafficNotInstalled")
        })?;
    if instance.status != "enabled" {
        return Err(ApiError::validation("Please enable traffic analysis first")
            .with_message_key("fileBrowser.enableTrafficAnalysisFirst"));
    }
    let app = list_apps(pool, locale, Some(node_id))
        .await?
        .into_iter()
        .find(|app| {
            app.suite_instance_id.as_deref() == Some(&instance.instance_id)
                && app.app_entry_id.as_deref() == Some("main")
                && app.entry_type.as_deref() == Some("proxied_web")
        })
        .ok_or_else(|| {
            ApiError::validation("Traffic analysis web entry is unavailable")
                .with_message_key("fileBrowser.trafficEntryUnavailable")
        })?;
    Ok((instance, app))
}

/// 固定实例、读取版本并通过带可信身份的 Agent 代理流式导入。
async fn send_capture(
    state: &AppState,
    node_id: &str,
    admin: &AuthenticatedAdmin,
    headers: &HeaderMap,
    source: &str,
) -> ApiResult<SendResult> {
    let locale = headers
        .get(header::ACCEPT_LANGUAGE)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split([',', ';']).next());
    let (instance, app) = resolve_target(&state.metadata_db, node_id, locale).await?;
    let (client, _) = node_client(state, node_id).await?;
    let context = operation_context(admin, headers)?;
    let detail_path = agent_query_path("/entry/detail", &[("path", source.to_owned())])?;
    let detail: FileEntryDetail = client.get_domain(&detail_path).await?;
    validate_capture(&detail)?;
    let size = detail.summary.size_bytes.unwrap_or_default();
    let revision = detail.summary.revision.clone();
    let transfer: FileTransfer = client
        .post_domain_with_operation_context(
            &format!("{AGENT_BASE_PATH}/transfers"),
            &CreateFileTransferRequest {
                direction: FileTransferDirection::Download,
                path: source.to_owned(),
                size_bytes: None,
                sha256: None,
                expected_revision: Some(revision.clone()),
                overwrite: false,
            },
            &context,
        )
        .await?;
    let _cleanup = TransferCleanup {
        client: client.clone(),
        context: context.clone(),
        id: transfer.transfer_id.clone(),
    };
    let response = client
        .forward_streaming_with_operation_context(
            Method::GET,
            &format!(
                "{AGENT_BASE_PATH}/transfer/{}/content",
                transfer.transfer_id
            ),
            HeaderMap::new(),
            Body::empty(),
            &context,
        )
        .await?;
    if !response.status().is_success() {
        return Err(ApiError::bad_gateway(
            ErrorCode::AgentRequestFailed,
            "Failed to read capture file",
        ));
    }
    let boundary = format!("veydeck-{}", uuid::Uuid::now_v7());
    // 避免文件名中的引号和换行影响 multipart 头，同时保留合法扩展名。
    let filename = detail.summary.name.replace(['\r', '\n', '"', '\\'], "_");
    let start = Bytes::from(format!(
        "--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{filename}\"\r\nContent-Type: application/octet-stream\r\n\r\n"
    ));
    let end = Bytes::from(format!("\r\n--{boundary}--\r\n"));
    let source_client = client.clone();
    let pool = state.metadata_db.clone();
    let source_node = node_id.to_owned();
    let expected_instance = instance.instance_id.clone();
    let verification_error = Arc::new(std::sync::Mutex::new(None));
    let stream_error = verification_error.clone();
    let body = capture_multipart_body(response.into_body(), size, start, end, async move {
        let result = async {
            verify_source(&source_client, &detail_path, &revision, size).await?;
            let (current, _) = resolve_target(&pool, &source_node, None).await?;
            if current.instance_id != expected_instance {
                return Err(ApiError::conflict(
                    ErrorCode::FileChanged,
                    "Traffic analysis instance changed",
                ));
            }
            Ok(())
        }
        .await;
        if let Err(error) = result {
            *stream_error.lock().expect("verification error lock") = Some(error);
            return Err(ApiError::validation("Capture verification failed"));
        }
        Ok(())
    });
    let mut upload_headers = HeaderMap::new();
    upload_headers.insert(
        header::CONTENT_TYPE,
        format!("multipart/form-data; boundary={boundary}")
            .parse()
            .map_err(|_| ApiError::internal("Invalid multipart boundary"))?,
    );
    let response = client
        .forward_streaming_with_operation_context(
            Method::POST,
            &format!(
                "/api/v1/agent/docker/suite/{}/proxy/main/api/pcaps",
                instance.compose_project_name
            ),
            upload_headers,
            body,
            &context,
        )
        .await;
    if let Some(error) = verification_error
        .lock()
        .expect("verification error lock")
        .take()
    {
        return Err(error);
    }
    let response = response?;
    let status = response.status();
    let payload = to_bytes(response.into_body(), 64 * 1024)
        .await
        .map_err(|_| {
            ApiError::bad_gateway(
                ErrorCode::AgentRequestFailed,
                "Invalid traffic analysis response",
            )
        })?;
    if !status.is_success() {
        let message = serde_json::from_slice::<serde_json::Value>(&payload)
            .ok()
            .and_then(|value| {
                value
                    .get("detail")
                    .and_then(|value| value.as_str())
                    .map(str::to_owned)
            })
            .unwrap_or_else(|| "Traffic analysis import failed".to_owned());
        return Err(ApiError::new(
            status,
            ErrorCode::AgentRequestFailed,
            message,
        ));
    }
    let payload: serde_json::Value = serde_json::from_slice(&payload).map_err(|_| {
        ApiError::bad_gateway(
            ErrorCode::AgentRequestFailed,
            "Invalid traffic analysis response",
        )
    })?;
    let import_id = payload
        .get("id")
        .and_then(|value| value.as_str())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            ApiError::bad_gateway(ErrorCode::AgentRequestFailed, "Missing capture import ID")
        })?
        .to_owned();
    Ok(SendResult { app, import_id })
}

#[cfg(test)]
mod tests {
    use super::*;
    use veydeck_contracts::files::{
        FileCapabilities, FileEntrySummary, FileManagement, FileManagementKind,
    };

    /// 构造具有真实能力与版本的普通抓包文件详情。
    fn capture(name: &str, size: u64) -> FileEntryDetail {
        FileEntryDetail {
            summary: FileEntrySummary {
                name: name.to_owned(),
                path: format!("/tmp/{name}"),
                kind: FileEntryKind::File,
                size_bytes: Some(size),
                revision: "revision-1".to_owned(),
                modified_at: None,
                created_at: None,
                management: FileManagement {
                    kind: FileManagementKind::Custom,
                    owner_name: None,
                    manage_via: None,
                },
                capabilities: FileCapabilities {
                    can_read: true,
                    ..Default::default()
                },
                symlink_target: None,
                symlink_target_kind: None,
                symlink_target_capabilities: None,
                symlink_error: None,
            },
            mode: 0o100644,
            uid: 0,
            gid: 0,
            user_name: None,
            group_name: None,
            accessed_at: None,
            allocated_bytes: 0,
        }
    }

    /// 其他节点的实例不作为后备，未启用及卸载后的旧状态均不能导入。
    #[tokio::test]
    async fn target_resolution_is_node_scoped_and_requires_enabled_instance() {
        use crate::models::suites::{
            SuiteManifest, SuitePackageSnapshot, import_package, insert_instance,
            update_instance_status,
        };
        let pool = crate::test_support::setup_test_db().await;
        let manifest: SuiteManifest = serde_json::from_value(json!({
            "kind": "ComposeSuite",
            "metadata": {"suiteId": SUITE_ID, "slug": "packet", "version": "1.0.0", "name": "流量解析", "icon": "assets/icon.png", "minVeydeckVersion": "0.1.0"},
            "compatibility": {"platformContractVersion": 1},
            "runtime": {"type": "compose", "composeFile": "compose.yaml"},
            "appEntries": [{"id": "main", "title": "流量解析", "type": "proxied_web"}]
        })).unwrap();
        let package_id = import_package(
            &pool,
            &manifest,
            &SuitePackageSnapshot { files: vec![] },
            "checksum",
        )
        .await
        .unwrap();
        let instance = SuiteInstanceSummary {
            package_id,
            instance_id: "packet-instance".to_owned(),
            suite_id: SUITE_ID.to_owned(),
            version: "1.0.0".to_owned(),
            platform_contract_version: 1,
            node_id: "node-a".to_owned(),
            compose_project_name: "veydeck-packet".to_owned(),
            status: "enabled".to_owned(),
            last_error: None,
            created_at: String::new(),
            updated_at: String::new(),
        };
        insert_instance(&pool, &instance).await.unwrap();
        sqlx::query("INSERT INTO suite_app_entries (app_id, suite_instance_id, node_id, app_entry_id, title, icon, entry_type, entry_target) VALUES ('packet-app', 'packet-instance', 'node-a', 'main', '流量解析', '/icon.png', 'proxied_web', '/suite/')").execute(&pool).await.unwrap();
        assert!(resolve_target(&pool, "local", None).await.is_err());
        assert!(resolve_target(&pool, "node-b", None).await.is_err());
        let (target, app) = resolve_target(&pool, "node-a", None).await.unwrap();
        assert_eq!(target.instance_id, "packet-instance");
        assert_eq!(app.node_id.as_deref(), Some("node-a"));
        for status in ["disabled", "disabling", "uninstalling", "error"] {
            update_instance_status(&pool, "packet-instance", status, None)
                .await
                .unwrap();
            assert!(resolve_target(&pool, "node-a", None).await.is_err());
        }
    }

    /// 两种扩展名不区分大小写，边界大小合法，链接和不可读源被拒绝。
    #[test]
    fn validates_capture_kind_permissions_and_limit() {
        for name in ["a.pcap", "a.PCAPNG", "a.PcAp"] {
            assert!(validate_capture(&capture(name, MAX_CAPTURE_BYTES)).is_ok());
        }
        assert!(validate_capture(&capture("a.pcap", MAX_CAPTURE_BYTES + 1)).is_err());
        assert!(validate_capture(&capture("a.txt", 1)).is_err());
        let mut detail = capture("a.pcap", 1);
        detail.summary.kind = FileEntryKind::Symlink;
        assert!(validate_capture(&detail).is_err());
        detail.summary.kind = FileEntryKind::Directory;
        assert!(validate_capture(&detail).is_err());
        detail.summary.kind = FileEntryKind::File;
        detail.summary.capabilities.can_read = false;
        assert!(validate_capture(&detail).is_err());
        assert!(
            serde_json::from_value::<SendRequest>(json!({"path":"/a.pcap", "nodeId":"other"}))
                .is_err()
        );
    }

    /// 无 Content-Length 的流式表单可被真实 multipart 提取器接收并保留文件名。
    #[tokio::test]
    async fn capture_upload_is_a_valid_streaming_multipart() {
        use axum::extract::{FromRequest, Multipart};
        let boundary = "veydeck-test-boundary";
        let start = Bytes::from(format!(
            "--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"抓包.PCAPNG\"\r\nContent-Type: application/octet-stream\r\n\r\n"
        ));
        let end = Bytes::from(format!("\r\n--{boundary}--\r\n"));
        let body = capture_multipart_body(
            Body::from(Bytes::from_static(b"capture-content")),
            15,
            start,
            end,
            async { Ok(()) },
        );
        let request = Request::builder()
            .method(Method::POST)
            .header(
                header::CONTENT_TYPE,
                format!("multipart/form-data; boundary={boundary}"),
            )
            .body(body)
            .unwrap();
        let mut multipart = Multipart::from_request(request, &()).await.unwrap();
        let file = multipart.next_field().await.unwrap().unwrap();
        assert_eq!(file.name(), Some("file"));
        assert_eq!(file.file_name(), Some("抓包.PCAPNG"));
        assert_eq!(file.bytes().await.unwrap(), "capture-content");
        assert!(multipart.next_field().await.unwrap().is_none());
    }

    /// 按小块传输恰好 100 MiB 时成功，额外字节在流中被拒绝而无需聚合文件。
    #[tokio::test]
    async fn stream_enforces_exact_capture_limit() {
        for extra in [false, true] {
            let chunk = Bytes::from(vec![0_u8; 1024 * 1024]);
            let chunks = (0..100).map(move |_| Ok::<_, io::Error>(chunk.clone()));
            let source = futures_util::stream::iter(chunks).chain(futures_util::stream::iter(
                extra.then_some(Ok::<_, io::Error>(Bytes::from_static(b"x"))),
            ));
            let body = capture_multipart_body(
                Body::from_stream(source),
                MAX_CAPTURE_BYTES,
                Bytes::new(),
                Bytes::new(),
                async { Ok(()) },
            );
            let mut stream = body.into_data_stream();
            let mut count = 0_u64;
            let mut failed = false;
            while let Some(chunk) = stream.next().await {
                match chunk {
                    Ok(chunk) => count += chunk.len() as u64,
                    Err(_) => {
                        failed = true;
                        break;
                    }
                }
            }
            assert_eq!(count, MAX_CAPTURE_BYTES);
            assert_eq!(failed, extra);
        }
    }

    /// 先发出表单头再读取源流，只有长度和版本校验通过才发送结束标记。
    #[tokio::test]
    async fn multipart_stream_rejects_truncation_growth_and_revision_changes() {
        let body = capture_multipart_body(
            Body::from("abc"),
            3,
            Bytes::from("header"),
            Bytes::from("footer"),
            async { Ok(()) },
        );
        assert_eq!(to_bytes(body, 1024).await.unwrap(), "headerabcfooter");
        for size in [2, 4] {
            let body = capture_multipart_body(
                Body::from("abc"),
                size,
                Bytes::new(),
                Bytes::from("footer"),
                async { Ok(()) },
            );
            assert!(to_bytes(body, 1024).await.is_err());
        }
        let body = capture_multipart_body(
            Body::from("abc"),
            3,
            Bytes::new(),
            Bytes::from("footer"),
            async { Err(ApiError::conflict(ErrorCode::FileChanged, "changed")) },
        );
        assert!(to_bytes(body, 1024).await.is_err());
        let source = Body::from_stream(futures_util::stream::pending::<Result<Bytes, io::Error>>());
        let mut stream =
            capture_multipart_body(source, 3, Bytes::from("header"), Bytes::new(), async {
                Ok(())
            })
            .into_data_stream();
        assert_eq!(
            tokio::time::timeout(std::time::Duration::from_secs(1), stream.next())
                .await
                .unwrap()
                .unwrap()
                .unwrap(),
            "header"
        );
    }
}
