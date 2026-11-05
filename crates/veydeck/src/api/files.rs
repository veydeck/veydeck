//! 文件管理语义网关：绑定节点、认证身份、稳定契约与最终操作日志。

use crate::{
    api::auth::AuthenticatedAdmin,
    models::{
        logging::{LogModule, LogStatus, PlatformLogLevel},
        node_runtime_client::{AgentOperationContext, NodeRuntimeClient},
        nodes::{self, NodeStatus},
    },
    services::{
        file_task_audit::{self, NewFileTaskAudit, NewFileTransferAudit},
        logging::{self, OperationEventBuilder},
        node_state_machine,
    },
    state::AppState,
    types::{ApiError, ApiResponse, ApiResult},
};
use axum::{
    Json, RequestExt, Router,
    body::Body,
    extract::{DefaultBodyLimit, Path, Query, Request, State},
    http::{HeaderMap, Method, StatusCode, header},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use serde::Deserialize;
use serde_json::json;
use std::{net::IpAddr, sync::Arc};
use veydeck_contracts::{
    api::ErrorCode,
    files::{
        CreateDirectoryRequest, CreateFileOperationTaskRequest, CreateFileRequest,
        CreateFileTransferRequest, FileDocument, FileEntryDetail, FileHome, FileListPage,
        FileOperationTask, FileSaveDurability, FileSaveResult, FileTransfer,
        UpdateFileContentRequest,
    },
};

const AGENT_BASE_PATH: &str = "/api/v1/agent/files";
const MAX_CHUNK_BYTES: usize = 8 * 1024 * 1024;
const MAX_TEXT_REQUEST_BYTES: usize = 4 * 1024 * 1024 * 6 + 64 * 1024;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FilePathQuery {
    path: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FileListQuery {
    path: String,
    #[serde(default = "default_page")]
    page: u32,
    #[serde(default = "default_page_size")]
    page_size: u32,
    #[serde(default = "default_sort_by")]
    sort_by: String,
    #[serde(default = "default_sort_order")]
    sort_order: String,
    #[serde(default)]
    show_hidden: bool,
}

/// 构建 node-scoped 文件管理公共路由。
pub fn file_router() -> Router<Arc<AppState>> {
    Router::new()
        .route("/{node_id}/files/home", get(home))
        .route("/{node_id}/files/list", get(list))
        .route("/{node_id}/file/detail", get(detail))
        .route(
            "/{node_id}/file/content",
            get(read_content)
                .put(update_content)
                .layer(DefaultBodyLimit::max(MAX_TEXT_REQUEST_BYTES)),
        )
        .route(
            "/{node_id}/files",
            post(create_file).layer(DefaultBodyLimit::max(MAX_TEXT_REQUEST_BYTES)),
        )
        .route("/{node_id}/directories", post(create_directory))
        .route("/{node_id}/file-operation-tasks", post(create_task))
        .route("/{node_id}/file-operation-tasks/active", get(active_tasks))
        .route(
            "/{node_id}/file-operation-task/{task_id}/detail",
            get(task_detail),
        )
        .route(
            "/{node_id}/file-operation-task/{task_id}/cancel",
            post(cancel_task),
        )
        .route("/{node_id}/file-transfers", post(create_transfer))
        .route("/{node_id}/file-transfers/active", get(active_transfers))
        .route(
            "/{node_id}/file-transfer/{transfer_id}/detail",
            get(transfer_detail),
        )
        .route(
            "/{node_id}/file-transfer/{transfer_id}/chunk",
            axum::routing::put(upload_chunk).layer(DefaultBodyLimit::max(MAX_CHUNK_BYTES)),
        )
        .route(
            "/{node_id}/file-transfer/{transfer_id}/complete",
            post(complete_transfer),
        )
        .route(
            "/{node_id}/file-transfer/{transfer_id}/cancel",
            post(cancel_transfer),
        )
        .route(
            "/{node_id}/file-transfer/{transfer_id}/content",
            get(download_content),
        )
}

async fn home(
    State(state): State<Arc<AppState>>,
    Path(node_id): Path<String>,
) -> ApiResult<Response> {
    let (client, _) = node_client(&state, &node_id).await?;
    let data: FileHome = client
        .get_domain(&format!("{AGENT_BASE_PATH}/home"))
        .await?;
    Ok(ApiResponse::success_with_raw("File home loaded", Some(data)).into_response())
}

async fn list(
    State(state): State<Arc<AppState>>,
    Path(node_id): Path<String>,
    Query(query): Query<FileListQuery>,
) -> ApiResult<Response> {
    validate_list_query(&query)?;
    let (client, _) = node_client(&state, &node_id).await?;
    let path = agent_query_path(
        "/list",
        &[
            ("path", query.path),
            ("page", query.page.to_string()),
            ("pageSize", query.page_size.to_string()),
            ("sortBy", query.sort_by),
            ("sortOrder", query.sort_order),
            ("showHidden", query.show_hidden.to_string()),
        ],
    )?;
    let data: FileListPage = client.get_domain(&path).await?;
    Ok(ApiResponse::success_with_raw("File list loaded", Some(data)).into_response())
}

async fn detail(
    State(state): State<Arc<AppState>>,
    Path(node_id): Path<String>,
    Query(query): Query<FilePathQuery>,
) -> ApiResult<Response> {
    let (client, _) = node_client(&state, &node_id).await?;
    let path = agent_query_path("/entry/detail", &[("path", query.path)])?;
    let data: FileEntryDetail = client.get_domain(&path).await?;
    Ok(ApiResponse::success_with_raw("File detail loaded", Some(data)).into_response())
}

async fn read_content(
    State(state): State<Arc<AppState>>,
    Path(node_id): Path<String>,
    Query(query): Query<FilePathQuery>,
) -> ApiResult<Response> {
    let (client, _) = node_client(&state, &node_id).await?;
    let path = agent_query_path("/content", &[("path", query.path)])?;
    let data: FileDocument = client.get_domain(&path).await?;
    Ok(ApiResponse::success_with_raw("File content loaded", Some(data)).into_response())
}

async fn create_file(
    State(state): State<Arc<AppState>>,
    Path(node_id): Path<String>,
    admin: AuthenticatedAdmin,
    headers: HeaderMap,
    Json(request): Json<CreateFileRequest>,
) -> ApiResult<Response> {
    let target = request.path.clone();
    let result: ApiResult<FileEntryDetail> =
        mutate_post(&state, &node_id, &admin, &headers, "/entries", &request).await;
    record_sync_operation(
        &state,
        &admin,
        &headers,
        &node_id,
        SyncOperationLog {
            event: "file_create",
            method: "POST",
            target: &target,
            high_impact: false,
            durability: None,
        },
        &result,
    );
    Ok(ApiResponse::success_with_raw("File created", Some(result?)).into_response())
}

async fn update_content(
    State(state): State<Arc<AppState>>,
    Path(node_id): Path<String>,
    admin: AuthenticatedAdmin,
    headers: HeaderMap,
    Json(request): Json<UpdateFileContentRequest>,
) -> ApiResult<Response> {
    let target = request.path.clone();
    let (client, _) = node_client(&state, &node_id).await?;
    let context = operation_context(&admin, &headers)?;
    let result = client
        .put_domain_with_operation_context::<FileSaveResult, _>(
            &format!("{AGENT_BASE_PATH}/content"),
            &request,
            &context,
        )
        .await;
    let durability = result.as_ref().ok().map(|save| save.durability);
    record_sync_operation(
        &state,
        &admin,
        &headers,
        &node_id,
        SyncOperationLog {
            event: "file_content_update",
            method: "PUT",
            target: &target,
            high_impact: durability == Some(FileSaveDurability::Uncertain),
            durability,
        },
        &result,
    );
    Ok(ApiResponse::success_with_raw("File content updated", Some(result?)).into_response())
}

async fn create_directory(
    State(state): State<Arc<AppState>>,
    Path(node_id): Path<String>,
    admin: AuthenticatedAdmin,
    headers: HeaderMap,
    Json(request): Json<CreateDirectoryRequest>,
) -> ApiResult<Response> {
    let target = request.path.clone();
    let result: ApiResult<FileEntryDetail> =
        mutate_post(&state, &node_id, &admin, &headers, "/directories", &request).await;
    record_sync_operation(
        &state,
        &admin,
        &headers,
        &node_id,
        SyncOperationLog {
            event: "directory_create",
            method: "POST",
            target: &target,
            high_impact: false,
            durability: None,
        },
        &result,
    );
    Ok(ApiResponse::success_with_raw("Directory created", Some(result?)).into_response())
}

async fn create_task(
    State(state): State<Arc<AppState>>,
    Path(node_id): Path<String>,
    admin: AuthenticatedAdmin,
    headers: HeaderMap,
    Json(request): Json<CreateFileOperationTaskRequest>,
) -> ApiResult<Response> {
    let result: ApiResult<FileOperationTask> = mutate_post(
        &state,
        &node_id,
        &admin,
        &headers,
        "/operation-tasks",
        &request,
    )
    .await;
    let log_target = result
        .as_ref()
        .map(|task| task.task_id.as_str())
        .unwrap_or(request.idempotency_key.as_str());
    record_sync_operation(
        &state,
        &admin,
        &headers,
        &node_id,
        SyncOperationLog {
            event: "file_task_submitted",
            method: "POST",
            target: log_target,
            high_impact: request.operation == veydeck_contracts::files::FileOperation::Remove,
            durability: None,
        },
        &result,
    );
    let mut task = result?;
    task.node_id = node_id.clone();
    if let Ok(context) = operation_context(&admin, &headers) {
        file_task_audit::register(
            &state.metadata_db,
            NewFileTaskAudit {
                task_id: &task.task_id,
                node_id: &node_id,
                user_id: admin.id,
                actor_name: &admin.username,
                client_ip: &context.client_ip,
                trace_id: &context.trace_id,
                operation: task.operation,
            },
        )
        .await;
    }
    Ok((
        StatusCode::ACCEPTED,
        ApiResponse::success_with_raw("File operation task accepted", Some(task)),
    )
        .into_response())
}

async fn task_detail(
    State(state): State<Arc<AppState>>,
    Path((node_id, task_id)): Path<(String, String)>,
) -> ApiResult<Response> {
    let (client, _) = node_client(&state, &node_id).await?;
    let mut task: FileOperationTask = client
        .get_domain(&format!(
            "{AGENT_BASE_PATH}/operation-task/{task_id}/detail"
        ))
        .await?;
    task.node_id = node_id;
    Ok(ApiResponse::success_with_raw("File operation task loaded", Some(task)).into_response())
}

async fn active_tasks(
    State(state): State<Arc<AppState>>,
    Path(node_id): Path<String>,
) -> ApiResult<Response> {
    let (client, _) = node_client(&state, &node_id).await?;
    let mut tasks: Vec<FileOperationTask> = client
        .get_domain(&format!("{AGENT_BASE_PATH}/operation-tasks/active"))
        .await?;
    for task in &mut tasks {
        task.node_id.clone_from(&node_id);
    }
    Ok(
        ApiResponse::success_with_raw("Active file operation tasks loaded", Some(tasks))
            .into_response(),
    )
}

async fn cancel_task(
    State(state): State<Arc<AppState>>,
    Path((node_id, task_id)): Path<(String, String)>,
    admin: AuthenticatedAdmin,
    headers: HeaderMap,
) -> ApiResult<Response> {
    let mut task: FileOperationTask = mutate_post(
        &state,
        &node_id,
        &admin,
        &headers,
        &format!("/operation-task/{task_id}/cancel"),
        &json!({}),
    )
    .await?;
    task.node_id = node_id;
    Ok(
        ApiResponse::success_with_raw("File operation task cancellation requested", Some(task))
            .into_response(),
    )
}

async fn create_transfer(
    State(state): State<Arc<AppState>>,
    Path(node_id): Path<String>,
    admin: AuthenticatedAdmin,
    headers: HeaderMap,
    Json(request): Json<CreateFileTransferRequest>,
) -> ApiResult<Response> {
    let mut transfer: FileTransfer =
        mutate_post(&state, &node_id, &admin, &headers, "/transfers", &request).await?;
    transfer.node_id = node_id;
    if let Ok(context) = operation_context(&admin, &headers) {
        file_task_audit::register_transfer(
            &state.metadata_db,
            NewFileTransferAudit {
                transfer_id: &transfer.transfer_id,
                node_id: &transfer.node_id,
                user_id: admin.id,
                actor_name: &admin.username,
                client_ip: &context.client_ip,
                trace_id: &context.trace_id,
                direction: transfer.direction,
                target_path: &transfer.path,
            },
        )
        .await;
    }
    Ok((
        StatusCode::CREATED,
        ApiResponse::success_with_raw("File transfer created", Some(transfer)),
    )
        .into_response())
}

async fn transfer_detail(
    State(state): State<Arc<AppState>>,
    Path((node_id, transfer_id)): Path<(String, String)>,
) -> ApiResult<Response> {
    let (client, _) = node_client(&state, &node_id).await?;
    let mut transfer: FileTransfer = client
        .get_domain(&format!("{AGENT_BASE_PATH}/transfer/{transfer_id}/detail"))
        .await?;
    transfer.node_id = node_id;
    Ok(ApiResponse::success_with_raw("File transfer loaded", Some(transfer)).into_response())
}

async fn active_transfers(
    State(state): State<Arc<AppState>>,
    Path(node_id): Path<String>,
) -> ApiResult<Response> {
    let (client, _) = node_client(&state, &node_id).await?;
    let mut transfers: Vec<FileTransfer> = client
        .get_domain(&format!("{AGENT_BASE_PATH}/transfers/active"))
        .await?;
    for transfer in &mut transfers {
        transfer.node_id.clone_from(&node_id);
    }
    Ok(
        ApiResponse::success_with_raw("Active file transfers loaded", Some(transfers))
            .into_response(),
    )
}

/// 检查声明长度并保留路由对实际字节流的限制，避免转发前整块聚合。
fn bounded_upload_body(request: Request) -> ApiResult<Body> {
    if let Some(length) = request.headers().get(header::CONTENT_LENGTH) {
        let length = length
            .to_str()
            .ok()
            .and_then(|value| value.parse::<usize>().ok())
            .ok_or_else(|| ApiError::validation("invalid upload content length"))?;
        if length > MAX_CHUNK_BYTES {
            return Err(ApiError::new(
                StatusCode::PAYLOAD_TOO_LARGE,
                ErrorCode::ValidationFailed,
                "upload chunk exceeds size limit",
            ));
        }
    }
    Ok(request.into_limited_body())
}

async fn upload_chunk(
    State(state): State<Arc<AppState>>,
    Path((node_id, transfer_id)): Path<(String, String)>,
    admin: AuthenticatedAdmin,
    incoming_headers: HeaderMap,
    request: Request,
) -> ApiResult<Response> {
    let body = bounded_upload_body(request)?;
    let (client, _) = node_client(&state, &node_id).await?;
    let context = operation_context(&admin, &incoming_headers)?;
    let mut headers = HeaderMap::new();
    if let Some(value) = incoming_headers.get(header::CONTENT_RANGE) {
        headers.insert(header::CONTENT_RANGE, value.clone());
    }
    if let Some(value) = incoming_headers.get(header::CONTENT_LENGTH) {
        headers.insert(header::CONTENT_LENGTH, value.clone());
    }
    client
        .forward_streaming_with_operation_context(
            Method::PUT,
            &format!("{AGENT_BASE_PATH}/transfer/{transfer_id}/chunk"),
            headers,
            body,
            &context,
        )
        .await
}

async fn complete_transfer(
    State(state): State<Arc<AppState>>,
    Path((node_id, transfer_id)): Path<(String, String)>,
    admin: AuthenticatedAdmin,
    headers: HeaderMap,
) -> ApiResult<Response> {
    let transfer: FileTransfer = mutate_post(
        &state,
        &node_id,
        &admin,
        &headers,
        &format!("/transfer/{transfer_id}/complete"),
        &json!({}),
    )
    .await?;
    Ok(ApiResponse::success_with_raw(
        "Upload completed",
        Some(FileTransfer {
            node_id,
            ..transfer
        }),
    )
    .into_response())
}

async fn cancel_transfer(
    State(state): State<Arc<AppState>>,
    Path((node_id, transfer_id)): Path<(String, String)>,
    admin: AuthenticatedAdmin,
    headers: HeaderMap,
) -> ApiResult<Response> {
    let transfer: FileTransfer = mutate_post(
        &state,
        &node_id,
        &admin,
        &headers,
        &format!("/transfer/{transfer_id}/cancel"),
        &json!({}),
    )
    .await?;
    Ok(ApiResponse::success_with_raw(
        "File transfer cancelled",
        Some(FileTransfer {
            node_id,
            ..transfer
        }),
    )
    .into_response())
}

async fn download_content(
    State(state): State<Arc<AppState>>,
    Path((node_id, transfer_id)): Path<(String, String)>,
    admin: AuthenticatedAdmin,
    incoming_headers: HeaderMap,
) -> ApiResult<Response> {
    let (client, _) = node_client(&state, &node_id).await?;
    let context = operation_context(&admin, &incoming_headers)?;
    let mut headers = HeaderMap::new();
    if let Some(value) = incoming_headers.get(header::RANGE) {
        headers.insert(header::RANGE, value.clone());
    }
    client
        .forward_streaming_with_operation_context(
            Method::GET,
            &format!("{AGENT_BASE_PATH}/transfer/{transfer_id}/content"),
            headers,
            Body::empty(),
            &context,
        )
        .await
}

async fn mutate_post<T, B>(
    state: &AppState,
    node_id: &str,
    admin: &AuthenticatedAdmin,
    headers: &HeaderMap,
    suffix: &str,
    payload: &B,
) -> ApiResult<T>
where
    T: serde::de::DeserializeOwned,
    B: serde::Serialize,
{
    let (client, _) = node_client(state, node_id).await?;
    let context = operation_context(admin, headers)?;
    client
        .post_domain_with_operation_context(
            &format!("{AGENT_BASE_PATH}{suffix}"),
            payload,
            &context,
        )
        .await
}

async fn node_client(state: &AppState, node_id: &str) -> ApiResult<(NodeRuntimeClient, String)> {
    let name = if node_id == "local" {
        "Local Node".to_string()
    } else {
        let node = nodes::get_node_by_id(&state.metadata_db, node_id)
            .await
            .map_err(|error| ApiError::database(error.to_string()))?
            .ok_or_else(|| ApiError::not_found(ErrorCode::NodeNotFound, "node does not exist"))?;
        let status = NodeStatus::parse(&node.status)
            .ok_or_else(|| ApiError::internal("node has an invalid lifecycle status"))?;
        if !node_state_machine::is_proxyable(status) {
            return Err(ApiError::new(
                StatusCode::SERVICE_UNAVAILABLE,
                ErrorCode::NodeUnavailable,
                "node is not available for file operations",
            ));
        }
        node.name
    };
    Ok((
        NodeRuntimeClient::from_node_route(&state.metadata_db, Some(node_id)).await?,
        name,
    ))
}

fn operation_context(
    admin: &AuthenticatedAdmin,
    headers: &HeaderMap,
) -> ApiResult<AgentOperationContext> {
    let client_ip = admin.session.client_ip.clone().ok_or_else(|| {
        ApiError::forbidden(
            ErrorCode::AuthForbidden,
            "authenticated session is missing a trusted client IP",
        )
    })?;
    Ok(AgentOperationContext {
        actor_user_id: admin.id,
        actor_name: admin.username.clone(),
        client_ip,
        trace_id: logging::resolve_trace_id(headers),
    })
}

fn agent_query_path(suffix: &str, pairs: &[(impl AsRef<str>, String)]) -> ApiResult<String> {
    let mut url = reqwest::Url::parse(&format!("http://agent{AGENT_BASE_PATH}{suffix}"))
        .map_err(|_| ApiError::internal("failed to build Agent file URL"))?;
    {
        let mut query = url.query_pairs_mut();
        for (key, value) in pairs {
            query.append_pair(key.as_ref(), value);
        }
    }
    Ok(format!(
        "{}?{}",
        url.path(),
        url.query().unwrap_or_default()
    ))
}

fn validate_list_query(query: &FileListQuery) -> ApiResult<()> {
    if query.page == 0
        || query.page_size == 0
        || query.page_size > 500
        || !["name", "modifiedAt", "sizeBytes"].contains(&query.sort_by.as_str())
        || !["asc", "desc"].contains(&query.sort_order.as_str())
    {
        return Err(ApiError::validation("invalid file list query"));
    }
    Ok(())
}

struct SyncOperationLog<'a> {
    event: &'a str,
    method: &'a str,
    target: &'a str,
    high_impact: bool,
    durability: Option<FileSaveDurability>,
}

fn record_sync_operation<T>(
    state: &AppState,
    admin: &AuthenticatedAdmin,
    headers: &HeaderMap,
    node_id: &str,
    log: SyncOperationLog<'_>,
    result: &ApiResult<T>,
) {
    let Some(client_ip) = admin
        .session
        .client_ip
        .as_deref()
        .and_then(|value| value.parse::<IpAddr>().ok())
    else {
        tracing::error!(
            event = log.event,
            "trusted session IP is invalid; file operation log skipped"
        );
        return;
    };
    let (status, level) = if result.is_err() {
        (LogStatus::Failed, PlatformLogLevel::Error)
    } else if log.high_impact {
        (LogStatus::Success, PlatformLogLevel::Warning)
    } else {
        (LogStatus::Success, PlatformLogLevel::Info)
    };
    let error_code = result.as_ref().err().map(|error| error.code.as_str());
    OperationEventBuilder::new(&admin.username, log.event, client_ip)
        .user_id(admin.id).module(LogModule::File).target_type("file").target_id(log.target)
        .trace_id(&logging::resolve_trace_id(headers)).source("veydeck_api")
        .request(log.method, "/api/v1/node/{node_id}/files")
        .metadata(json!({ "nodeId": node_id, "result": if result.is_ok() { "success" } else { "failed" }, "errorCode": error_code, "durability": log.durability }))
        .status(status).level(level).finish(&state.metadata_db);
}

fn default_page() -> u32 {
    1
}
fn default_page_size() -> u32 {
    50
}
fn default_sort_by() -> String {
    "name".to_string()
}
fn default_sort_order() -> String {
    "asc".to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn list_query_rejects_unbounded_pages() {
        let query = FileListQuery {
            path: "/".to_string(),
            page: 1,
            page_size: 501,
            sort_by: "name".to_string(),
            sort_order: "asc".to_string(),
            show_hidden: false,
        };
        assert!(validate_list_query(&query).is_err());
    }
    /// 验证上传在请求结束前即可被消费，声明长度和实际流仍受同一上限约束。
    #[tokio::test]
    async fn upload_body_streams_early_and_keeps_size_limits() {
        use axum::body::Bytes;
        use std::io;
        use tokio_stream::{StreamExt, wrappers::ReceiverStream};
        let (first_tx, first_rx) = tokio::sync::oneshot::channel();
        let first_tx = Arc::new(tokio::sync::Mutex::new(Some(first_tx)));
        let app = Router::new()
            .route(
                "/upload",
                axum::routing::put(move |request: Request| {
                    let first_tx = first_tx.clone();
                    async move {
                        let body = match bounded_upload_body(request) {
                            Ok(body) => body,
                            Err(error) => return error.into_response(),
                        };
                        let mut stream = body.into_data_stream();
                        let mut received = 0;
                        while let Some(chunk) = stream.next().await {
                            match chunk {
                                Ok(chunk) => {
                                    received += chunk.len();
                                    if let Some(sender) = first_tx.lock().await.take() {
                                        let _ = sender.send(());
                                    }
                                }
                                Err(_) => return StatusCode::PAYLOAD_TOO_LARGE.into_response(),
                            }
                        }
                        received.to_string().into_response()
                    }
                }),
            )
            .layer(DefaultBodyLimit::max(MAX_CHUNK_BYTES));
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let handle = axum_server::Handle::new();
        let server = axum_server::Server::from_tcp(listener).handle(handle.clone());
        let serving = tokio::spawn(server.serve(app.into_make_service()));
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        let (sender, receiver) = tokio::sync::mpsc::channel::<Result<Bytes, io::Error>>(2);
        let request = client
            .put(format!("http://{address}/upload"))
            .body(reqwest::Body::wrap_stream(ReceiverStream::new(receiver)))
            .send();
        let pending = tokio::spawn(request);
        sender.send(Ok(Bytes::from_static(b"first"))).await.unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(5), first_rx)
            .await
            .unwrap()
            .unwrap();
        sender
            .send(Ok(Bytes::from_static(b"second")))
            .await
            .unwrap();
        drop(sender);
        assert_eq!(pending.await.unwrap().unwrap().text().await.unwrap(), "11");
        let oversized = Bytes::from(vec![0; MAX_CHUNK_BYTES + 1]);
        let response = client
            .put(format!("http://{address}/upload"))
            .body(oversized.clone())
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);
        let response = client
            .put(format!("http://{address}/upload"))
            .body(reqwest::Body::wrap_stream(tokio_stream::iter([Ok::<
                _,
                io::Error,
            >(
                oversized,
            )])))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);
        handle.shutdown();
        serving.await.unwrap().unwrap();
    }
}
