//! 套件不可变版本包、多节点隔离与并发占用回归测试。

use super::*;
use crate::test_support::setup_test_db;
use axum::http::StatusCode;

/// 构造具有版本专属入口和资源的套件包。
fn fixture(version: &str) -> (SuiteManifest, SuitePackageSnapshot) {
    let manifest = serde_json::from_value(serde_json::json!({
        "apiVersion": "veydeck.io/v1alpha1", "kind": "ComposeSuite",
        "metadata": {
            "suiteId": "versioned-suite", "slug": "versioned-suite", "version": version,
            "name": format!("套件 {version}"), "icon": "assets/icon.png",
            "minVeydeckVersion": "0.1.0-alpha.1"
        },
        "compatibility": { "platformContractVersion": 1 },
        "runtime": { "type": "compose", "composeFile": "compose.yaml" },
        "appEntries": [{ "id": "main", "title": format!("入口 {version}"), "type": "web" }],
        "i18n": { "defaultLocale": "zh", "locales": {
            "zh": { "appEntries": { "main": { "title": format!("中文入口 {version}") } } }
        } }
    }))
    .unwrap();
    let package = SuitePackageSnapshot {
        files: vec![SuitePackageFile {
            path: "assets/icon.png".to_string(),
            content_base64: version.to_string(),
        }],
    };
    (manifest, package)
}

/// 构造绑定明确版本包的节点实例和安装任务。
fn installation(
    package_id: &str,
    version: &str,
    node_id: &str,
) -> (SuiteInstanceSummary, SuiteInstallTaskRecord) {
    let instance_id = format!("instance-{node_id}");
    let instance = SuiteInstanceSummary {
        package_id: package_id.to_string(),
        instance_id: instance_id.clone(),
        suite_id: "versioned-suite".to_string(),
        version: version.to_string(),
        platform_contract_version: 1,
        node_id: node_id.to_string(),
        compose_project_name: "veydeck-versioned-suite".to_string(),
        status: "installing".to_string(),
        last_error: None,
        created_at: String::new(),
        updated_at: String::new(),
    };
    let task = SuiteInstallTaskRecord {
        package_id: package_id.to_string(),
        version: version.to_string(),
        checksum: version.to_string(),
        task_id: format!("task-{node_id}"),
        instance_id,
        suite_id: instance.suite_id.clone(),
        node_id: node_id.to_string(),
        progress_percent: 1,
        status: "queued".to_string(),
        current_step: "queued".to_string(),
        current_image: None,
        is_finished: false,
        error: None,
        error_code: None,
        cancel_requested: false,
        recovery_started_at: None,
        created_at: String::new(),
        updated_at: String::new(),
        finished_at: None,
    };
    (instance, task)
}

/// 同版本重复导入和直接更新均不能覆盖包，其他版本可以共存。
#[tokio::test]
async fn suite_packages_are_immutable_and_duplicate_import_is_atomic() {
    let pool = setup_test_db().await;
    let (manifest, package) = fixture("1.0.0");
    let (first, second) = tokio::join!(
        import_package(&pool, &manifest, &package, "1.0.0"),
        import_package(&pool, &manifest, &package, "different-content")
    );
    let (package_id, error) = match (first, second) {
        (Ok(id), Err(error)) | (Err(error), Ok(id)) => (id, error),
        other => panic!("unexpected import results: {other:?}"),
    };
    assert_eq!(error.status, StatusCode::CONFLICT);
    assert_eq!(error.code, ErrorCode::SuiteVersionAlreadyExists);
    assert!(
        sqlx::query("UPDATE suite_packages SET version = '2.0.0' WHERE package_id = ?")
            .bind(&package_id)
            .execute(&pool)
            .await
            .is_err()
    );
    let (v2, p2) = fixture("2.0.0");
    import_package(&pool, &v2, &p2, "2.0.0").await.unwrap();
    let list = list_suites(&pool, Some("zh"), Some("local")).await.unwrap();
    assert_eq!(list.catalog.len(), 1);
    assert_eq!(list.catalog[0].versions.len(), 2);
    assert_eq!(list.catalog[0].versions[0].version, "2.0.0");
}

/// 两个节点使用不同版本，后续导入和单节点卸载不影响另一节点的入口及资源。
#[tokio::test]
async fn suite_nodes_keep_their_bound_resources_and_localized_entries() {
    let pool = setup_test_db().await;
    let mut packages = Vec::new();
    for (version, node_id) in [("1.0.0", "local"), ("2.0.0", "node-a")] {
        let (manifest, package) = fixture(version);
        let id = import_package(&pool, &manifest, &package, version)
            .await
            .unwrap();
        let (instance, task) = installation(&id, version, node_id);
        reserve_installation(&pool, &instance, &task).await.unwrap();
        update_install_task(
            &pool,
            &task.task_id,
            100,
            "success",
            "completed",
            None,
            true,
            None,
        )
        .await
        .unwrap();
        update_instance_status(&pool, &instance.instance_id, "enabled", None)
            .await
            .unwrap();
        sqlx::query("INSERT INTO suite_app_entries (app_id, suite_instance_id, node_id, app_entry_id, title, icon, entry_type, entry_target) VALUES (?, ?, ?, 'main', 'fallback', '', 'web', '/')")
            .bind(format!("app-{node_id}")).bind(&instance.instance_id).bind(node_id)
            .execute(&pool).await.unwrap();
        packages.push(id);
    }
    let (v3, p3) = fixture("3.0.0");
    let free = import_package(&pool, &v3, &p3, "3.0.0").await.unwrap();
    for (index, (node_id, version)) in [("local", "1.0.0"), ("node-a", "2.0.0")]
        .into_iter()
        .enumerate()
    {
        let instance = fetch_instance(&pool, &format!("instance-{node_id}"))
            .await
            .unwrap()
            .unwrap();
        let (manifest, package) = fetch_package_payload(&pool, &instance.package_id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(manifest.metadata.version, version);
        assert_eq!(package.files[0].content_base64, version);
        let apps = crate::models::apps::list_apps(&pool, Some("zh"), Some(node_id))
            .await
            .unwrap();
        assert!(
            apps.iter()
                .any(|app| app.title.as_deref() == Some(&format!("中文入口 {version}")))
        );
        let blockers = delete_packages(&pool, "versioned-suite", Some(&packages[index]))
            .await
            .unwrap();
        assert_eq!(blockers.len(), 1);
        assert_eq!(blockers[0].node_id, node_id);
    }
    assert_eq!(
        delete_packages(&pool, "versioned-suite", None)
            .await
            .unwrap()
            .len(),
        2
    );
    assert!(
        delete_packages(&pool, "versioned-suite", Some(&free))
            .await
            .unwrap()
            .is_empty()
    );
    delete_instance(&pool, "instance-local").await.unwrap();
    assert!(
        delete_packages(&pool, "versioned-suite", Some(&packages[0]))
            .await
            .unwrap()
            .is_empty()
    );
    assert!(
        fetch_instance(&pool, "instance-node-a")
            .await
            .unwrap()
            .is_some()
    );
    assert!(
        fetch_package_payload(&pool, &packages[1])
            .await
            .unwrap()
            .is_some()
    );
}

/// 活跃任务独立阻止删包；结束后的历史任务可保留审计且不能重新激活。
#[tokio::test]
async fn suite_active_tasks_block_deletion_but_history_does_not() {
    let pool = setup_test_db().await;
    let (manifest, package) = fixture("1.0.0");
    let id = import_package(&pool, &manifest, &package, "1.0.0")
        .await
        .unwrap();
    let (instance, task) = installation(&id, "1.0.0", "local");
    reserve_installation(&pool, &instance, &task).await.unwrap();
    delete_instance(&pool, &instance.instance_id).await.unwrap();
    let blockers = delete_packages(&pool, "versioned-suite", Some(&id))
        .await
        .unwrap();
    assert_eq!(blockers[0].task_id.as_deref(), Some(task.task_id.as_str()));
    assert!(
        sqlx::query("DELETE FROM suite_packages WHERE package_id = ?")
            .bind(&id)
            .execute(&pool)
            .await
            .is_err()
    );
    update_install_task(
        &pool,
        &task.task_id,
        100,
        "canceled",
        "canceled",
        None,
        true,
        None,
    )
    .await
    .unwrap();
    assert!(
        delete_packages(&pool, "versioned-suite", Some(&id))
            .await
            .unwrap()
            .is_empty()
    );
    update_install_task(
        &pool,
        &task.task_id,
        50,
        "running",
        "prepare",
        None,
        false,
        None,
    )
    .await
    .unwrap();
    let history = fetch_install_task(&pool, &task.task_id)
        .await
        .unwrap()
        .unwrap();
    assert!(history.is_finished);
    assert_eq!(history.package_id, id);
    assert_eq!(history.version, "1.0.0");
    assert_eq!(history.checksum, "1.0.0");
}

/// 版本身份不能混用，同一节点不能并行安装两个版本。
#[tokio::test]
async fn suite_reservation_rejects_mismatched_packages_and_duplicate_nodes() {
    let pool = setup_test_db().await;
    let (manifest, package) = fixture("1.0.0");
    let id = import_package(&pool, &manifest, &package, "1.0.0")
        .await
        .unwrap();
    let (instance, task) = installation(&id, "2.0.0", "local");
    assert!(reserve_installation(&pool, &instance, &task).await.is_err());
    assert!(
        fetch_instance(&pool, &instance.instance_id)
            .await
            .unwrap()
            .is_none()
    );
    assert!(insert_instance(&pool, &instance).await.is_err());
    let (instance, task) = installation(&id, "1.0.0", "local");
    reserve_installation(&pool, &instance, &task).await.unwrap();
    let mut other = instance.clone();
    other.instance_id = "another-instance".to_string();
    let mut other_task = task.clone();
    other_task.instance_id = other.instance_id.clone();
    other_task.task_id = "another-task".to_string();
    let error = reserve_installation(&pool, &other, &other_task)
        .await
        .unwrap_err();
    assert_eq!(error.code, ErrorCode::SuiteAlreadyInstalled);
    assert!(
        fetch_install_task(&pool, "another-task")
            .await
            .unwrap()
            .is_none()
    );
}

/// 不同数据库连接上的安装与删除竞争不能产生悬空实例或任务。
#[tokio::test]
async fn suite_install_and_delete_are_serialized_across_connections() {
    let path = std::env::temp_dir().join(format!("suite-race-{}.db", uuid::Uuid::now_v7()));
    let options = sqlx::sqlite::SqliteConnectOptions::new()
        .filename(&path)
        .create_if_missing(true)
        .foreign_keys(true)
        .busy_timeout(std::time::Duration::from_secs(5));
    let pool = sqlx::sqlite::SqlitePoolOptions::new()
        .max_connections(4)
        .connect_with(options)
        .await
        .unwrap();
    sqlx::migrate!("./migrations").run(&pool).await.unwrap();
    let (manifest, package) = fixture("1.0.0");
    let id = import_package(&pool, &manifest, &package, "1.0.0")
        .await
        .unwrap();
    let (instance, task) = installation(&id, "1.0.0", "local");
    let (installed, deleted) = tokio::join!(
        reserve_installation(&pool, &instance, &task),
        delete_packages(&pool, "versioned-suite", Some(&id))
    );
    let blockers = deleted.unwrap();
    if installed.is_ok() {
        assert!(!blockers.is_empty());
        assert!(fetch_package_payload(&pool, &id).await.unwrap().is_some());
        assert!(
            fetch_install_task(&pool, &task.task_id)
                .await
                .unwrap()
                .is_some()
        );
    } else {
        assert!(blockers.is_empty());
        assert!(
            fetch_instance(&pool, &instance.instance_id)
                .await
                .unwrap()
                .is_none()
        );
        assert!(
            fetch_install_task(&pool, &task.task_id)
                .await
                .unwrap()
                .is_none()
        );
    }
    pool.close().await;
    std::fs::remove_file(path).unwrap();
}
