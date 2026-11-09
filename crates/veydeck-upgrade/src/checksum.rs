//! SHA256 摘要与 checksum 文本解析。

use ring::digest;
use std::fs::File;
use std::io::{self, Read};
use std::path::Path;
use std::sync::OnceLock;
use thiserror::Error;

/// checksum 解析或校验错误。
#[derive(Debug, Error)]
pub enum ChecksumError {
    #[error("sha256 must be a 64-character hex string")]
    InvalidSha256,
    #[error("checksum file does not contain a valid sha256 entry")]
    MissingEntry,
    #[error("sha256 mismatch")]
    Mismatch,
}

/// 计算 SHA256 hex 摘要。
pub fn compute_sha256_hex(bytes: &[u8]) -> String {
    hex::encode(digest::digest(&digest::SHA256, bytes).as_ref())
}

/// 流式计算文件摘要，避免将整个可执行文件读入内存。
pub fn compute_file_sha256(path: &Path) -> io::Result<String> {
    let mut file = File::open(path)?;
    let mut context = digest::Context::new(&digest::SHA256);
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let count = file.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        context.update(&buffer[..count]);
    }
    Ok(hex::encode(context.finish().as_ref()))
}

/// 对运行中进程的可执行文件计算摘要；原子替换安装文件后仍读取原进程映像。
pub fn running_executable_sha256() -> io::Result<String> {
    static HASH: OnceLock<String> = OnceLock::new();
    if let Some(hash) = HASH.get() {
        return Ok(hash.clone());
    }
    let hash = compute_file_sha256(Path::new("/proc/self/exe"))?;
    let _ = HASH.set(hash.clone());
    Ok(hash)
}

/// 规范化 SHA256 hex 字符串。
pub fn normalize_sha256(value: &str) -> Result<String, ChecksumError> {
    let normalized = value.trim().to_lowercase();
    if normalized.len() != 64 || !normalized.chars().all(|ch| ch.is_ascii_hexdigit()) {
        return Err(ChecksumError::InvalidSha256);
    }
    Ok(normalized)
}

/// 校验 bytes 的 SHA256 是否等于 expected。
pub fn verify_sha256(bytes: &[u8], expected: &str) -> Result<String, ChecksumError> {
    let expected = normalize_sha256(expected)?;
    let actual = compute_sha256_hex(bytes);
    if actual != expected {
        return Err(ChecksumError::Mismatch);
    }
    Ok(actual)
}

/// 解析 checksum 文本，支持单独摘要或 `<sha256> <file>` 格式。
pub fn parse_checksum_text(text: &str, artifact_name: &str) -> Result<String, ChecksumError> {
    for line in text.lines().map(str::trim).filter(|line| !line.is_empty()) {
        let mut parts = line.split_whitespace();
        let Some(checksum) = parts.next() else {
            continue;
        };
        let Ok(checksum) = normalize_sha256(checksum) else {
            continue;
        };
        let matches_artifact = parts
            .next()
            .map(|name| name.trim_start_matches('*') == artifact_name)
            .unwrap_or(true);
        if matches_artifact {
            return Ok(checksum);
        }
    }
    Err(ChecksumError::MissingEntry)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 原子替换安装文件后，进程映像摘要必须保持原值且区别于新安装文件。
    #[test]
    fn running_image_remains_distinct_from_replaced_installation() {
        let directory = std::env::temp_dir().join(format!(
            "veydeck-hash-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir(&directory).unwrap();
        let installed = directory.join("agent");
        let staged = directory.join("agent.next");
        std::fs::copy("/bin/sleep", &installed).unwrap();
        let old_hash = compute_file_sha256(&installed).unwrap();
        let mut process = std::process::Command::new(&installed)
            .arg("60")
            .spawn()
            .unwrap();
        let result = (|| -> io::Result<(String, String)> {
            std::fs::copy("/bin/true", &staged)?;
            std::fs::rename(&staged, &installed)?;
            Ok((
                compute_file_sha256(&std::path::PathBuf::from(format!(
                    "/proc/{}/exe",
                    process.id()
                )))?,
                compute_file_sha256(&installed)?,
            ))
        })();
        let _ = process.kill();
        let _ = process.wait();
        let payload = vec![0xab_u8; 131_123];
        let data_file = directory.join("multi-buffer-data");
        std::fs::write(&data_file, &payload).unwrap();
        let streamed_hash = compute_file_sha256(&data_file).unwrap();
        std::fs::remove_dir_all(directory).unwrap();
        assert_eq!(streamed_hash, compute_sha256_hex(&payload));
        let (running, installed) = result.unwrap();
        assert_eq!(running, old_hash);
        assert_ne!(running, installed);
    }

    /// 文件读取错误必须向上传递，运行中二进制摘要应与实际进程映像一致。
    #[test]
    fn executable_hash_is_verified_and_read_errors_are_not_silenced() {
        let expected = compute_file_sha256(Path::new("/proc/self/exe")).unwrap();
        assert_eq!(running_executable_sha256().unwrap(), expected);
        assert_eq!(running_executable_sha256().unwrap(), expected);
        let missing =
            std::env::temp_dir().join(format!("veydeck-missing-executable-{}", std::process::id()));
        assert!(compute_file_sha256(&missing).is_err());
    }

    #[test]
    fn parse_accepts_single_checksum() {
        let checksum = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
        assert_eq!(parse_checksum_text(checksum, "a").unwrap(), checksum);
    }

    #[test]
    fn parse_selects_named_entry() {
        let expected = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        let raw = format!(
            "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb b\n{expected} *a\n"
        );
        assert_eq!(parse_checksum_text(&raw, "a").unwrap(), expected);
    }
}
