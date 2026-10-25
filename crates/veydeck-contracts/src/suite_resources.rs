//! 套件持久化目录和受限引擎操作声明。
use serde::{Deserialize, Serialize};

/// 由 Agent 管理的套件资源，业务目录由平台根据套件 ID 分配。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SuiteResources {
    /// 授予固定 Nginx 控制操作的 Compose 服务。
    pub engine_service: String,
    /// 允许接收内部代理凭据的管理服务。
    pub manager_service: String,
}

impl SuiteResources {
    /// 返回平台分配的 www 子目录，拒绝套件自行指定目录或复用平台目录。
    pub fn data_directory(suite_id: &str) -> Result<&'static str, &'static str> {
        match suite_id {
            "veydeck.websites" => Ok("websites"),
            _ => Err("persistent resources are not allocated for this suite"),
        }
    }

    /// 拒绝路径、环境变量插值及不安全服务名。
    pub fn validate(&self) -> Result<(), &'static str> {
        for value in [&self.engine_service, &self.manager_service] {
            if value.is_empty()
                || value.len() > 64
                || !value
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
            {
                return Err("resource names must contain lowercase letters, digits or hyphens");
            }
        }
        if self.engine_service == self.manager_service {
            return Err("engine and manager must be separate services");
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    /// 数据路径来自平台白名单，旧 namespace 字段与未知套件均被拒绝。
    #[test]
    fn resource_data_directory_is_assigned_by_platform() {
        assert_eq!(
            SuiteResources::data_directory("veydeck.websites"),
            Ok("websites")
        );
        for suite in ["compose", "../compose", "veydeck.other", "websites"] {
            assert!(SuiteResources::data_directory(suite).is_err());
        }
        assert!(
            serde_json::from_str::<SuiteResources>(
                r#"{"namespace":"compose","engineService":"nginx","managerService":"manager"}"#
            )
            .is_err()
        );
    }

    #[test]
    fn resource_names_cannot_escape_data_directory() {
        for name in ["../websites", "/tmp", "${HOME}", "a/b", ""] {
            assert!(
                SuiteResources {
                    engine_service: name.into(),
                    manager_service: "manager".into()
                }
                .validate()
                .is_err()
            );
        }
    }
}
