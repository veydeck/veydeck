//! 本机上传接收基准：对比 HTTP/1、HTTP/2 默认、自适应及分块大小窗口。
//! 运行 `cargo run --release -p veydeck --example upload-throughput`，使用临时端口且不写入文件。
//! 结果只用于本机协议配置对比，不代表含 TLS、磁盘和节点转发的端到端吞吐。
use axum::{Router, body::Bytes, extract::DefaultBodyLimit, routing::put};
use std::time::Instant;

/// 单次测量固定分块上传，服务端消费完整请求体后再确认。
async fn measure(http2: bool, adaptive: bool, large_window: bool) -> anyhow::Result<()> {
    let app = Router::new()
        .route(
            "/upload",
            put(|body: Bytes| async move { body.len().to_string() }),
        )
        .layer(DefaultBodyLimit::max(8 * 1024 * 1024));
    let listener = std::net::TcpListener::bind("127.0.0.1:0")?;
    let address = listener.local_addr()?;
    let handle = axum_server::Handle::new();
    let mut server = axum_server::Server::from_tcp(listener).handle(handle.clone());
    let mut http2_builder = server.http_builder().http2();
    http2_builder.adaptive_window(adaptive);
    if large_window {
        http2_builder
            .initial_stream_window_size(8 * 1024 * 1024)
            .initial_connection_window_size(16 * 1024 * 1024);
    }
    let serving = tokio::spawn(server.serve(app.into_make_service()));
    let builder = reqwest::Client::builder().no_proxy();
    let client = if http2 {
        builder.http2_prior_knowledge()
    } else {
        builder.http1_only()
    }
    .build()?;
    let payload = Bytes::from(vec![0x91; 8 * 1024 * 1024]);
    let started = Instant::now();
    for _ in 0..16 {
        let response = client
            .put(format!("http://{address}/upload"))
            .body(payload.clone())
            .send()
            .await?;
        anyhow::ensure!(response.status().is_success());
        response.bytes().await?;
    }
    println!(
        "http2={http2} adaptive={adaptive} large_window={large_window}: {:.1} MiB/s",
        128.0 / started.elapsed().as_secs_f64()
    );
    handle.shutdown();
    serving.await??;
    Ok(())
}

/// 顺序运行，避免不同协议的样本争抢资源。
#[tokio::main]
async fn main() -> anyhow::Result<()> {
    measure(false, false, false).await?;
    measure(true, false, false).await?;
    measure(true, true, false).await?;
    measure(true, false, true).await?;
    Ok(())
}
