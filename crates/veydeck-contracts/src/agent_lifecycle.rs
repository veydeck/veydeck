//! Agent 与卸载工具之间的跨进程生命周期互斥。

use std::fs::{File, OpenOptions};
use std::io;
use std::path::Path;

/// 获取生命周期锁；共享锁保护套件变更，排他锁保护完整卸载事务。
pub fn acquire(path: &Path, exclusive: bool) -> io::Result<File> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let file = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(path)?;
    let result = if exclusive {
        file.try_lock()
    } else {
        file.try_lock_shared()
    };
    result.map_err(|error| {
        io::Error::other(format!("Agent lifecycle operation is in progress; try again later: {error}"))
    })?;
    Ok(file)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 独立文件描述符之间共享锁可并存，排他锁必须拒绝并发。
    #[test]
    fn exclusive_lock_blocks_shared_changes() {
        let path =
            std::env::temp_dir().join(format!("veydeck-lifecycle-{}.lock", std::process::id()));
        let shared = acquire(&path, false).unwrap();
        assert!(acquire(&path, false).is_ok());
        assert!(acquire(&path, true).is_err());
        drop(shared);
        let exclusive = acquire(&path, true).unwrap();
        assert!(acquire(&path, false).is_err());
        drop(exclusive);
        std::fs::remove_file(path).unwrap();
    }
}
