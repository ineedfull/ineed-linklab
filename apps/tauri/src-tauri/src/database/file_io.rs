// Safe workspace file access and atomic writes.
use super::*;

pub(super) fn safe_file_metadata(
    path: &Path,
    allow_missing: bool,
) -> DbResult<Option<std::fs::Metadata>> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) => {
            if metadata.file_type().is_symlink() {
                return Err("Workspace path must not be a symbolic link".into());
            }
            if !metadata.is_file() {
                return Err("Workspace path must be a regular file".into());
            }
            Ok(Some(metadata))
        }
        Err(error) if allow_missing && error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

pub(super) fn read_workspace_source(path: &Path) -> DbResult<String> {
    read_open_workspace_source(open_workspace_import(path)?)
}

pub(super) fn open_workspace_import(path: &Path) -> DbResult<File> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt as _;
        const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
        options.custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
    }
    let file = options.open(path).map_err(|error| {
        if error.raw_os_error() == Some(libc::ELOOP) {
            "Workspace path must not be a symbolic link".to_owned()
        } else {
            error.to_string()
        }
    })?;
    let metadata = file.metadata().map_err(|error| error.to_string())?;
    if metadata.file_type().is_symlink() {
        return Err("Workspace path must not be a symbolic link".into());
    }
    if !metadata.is_file() {
        return Err("Workspace path must be a regular file".into());
    }
    if metadata.len() > MAX_WORKSPACE_BYTES as u64 {
        return Err("Workspace import exceeds 10 MiB".into());
    }
    Ok(file)
}

pub(super) fn read_open_workspace_source(file: File) -> DbResult<String> {
    let mut bytes = Vec::with_capacity(MAX_WORKSPACE_BYTES.min(64 * 1024));
    file.take(MAX_WORKSPACE_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    if bytes.len() > MAX_WORKSPACE_BYTES {
        return Err("Workspace import exceeds 10 MiB".into());
    }
    String::from_utf8(bytes).map_err(|error| error.to_string())
}

pub(super) fn atomic_write_workspace(destination: &Path, contents: &[u8]) -> DbResult<()> {
    if contents.len() > MAX_WORKSPACE_BYTES {
        return Err("Workspace export exceeds 10 MiB".into());
    }
    safe_file_metadata(destination, true)?;
    let directory = destination
        .parent()
        .ok_or_else(|| "Workspace destination has no parent directory".to_owned())?;
    let name = destination
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "Workspace destination file name is invalid".to_owned())?;
    let mut temporary = None;
    let mut file = None;
    for attempt in 0..100_u32 {
        let candidate = directory.join(format!(
            ".{name}.{}.{}.{attempt}.tmp",
            std::process::id(),
            now_millis()?
        ));
        match OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&candidate)
        {
            Ok(opened) => {
                temporary = Some(candidate);
                file = Some(opened);
                break;
            }
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error.to_string()),
        }
    }
    let temporary =
        temporary.ok_or_else(|| "Could not create workspace temporary file".to_owned())?;
    let result = (|| -> DbResult<()> {
        let mut file = file.take().expect("temporary file handle");
        file.write_all(contents)
            .map_err(|error| error.to_string())?;
        file.sync_all().map_err(|error| error.to_string())?;
        drop(file);
        std::fs::rename(&temporary, destination).map_err(|error| error.to_string())?;
        File::open(directory)
            .and_then(|directory| directory.sync_all())
            .map_err(|error| error.to_string())?;
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    result
}

pub(super) fn atomic_write_stream<T, F>(destination: &Path, writer: F) -> DbResult<T>
where
    F: FnOnce(&mut File) -> DbResult<T>,
{
    safe_file_metadata(destination, true)?;
    let directory = destination
        .parent()
        .ok_or_else(|| "Export destination has no parent directory".to_owned())?;
    let name = destination
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "Export destination file name is invalid".to_owned())?;
    let mut temporary = None;
    let mut file = None;
    for attempt in 0..100_u32 {
        let candidate = directory.join(format!(
            ".{name}.{}.{}.{attempt}.tmp",
            std::process::id(),
            now_millis()?
        ));
        match OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&candidate)
        {
            Ok(opened) => {
                temporary = Some(candidate);
                file = Some(opened);
                break;
            }
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error.to_string()),
        }
    }
    let temporary = temporary.ok_or_else(|| "Could not create export temporary file".to_owned())?;
    let result = (|| -> DbResult<T> {
        let mut file = file.take().expect("temporary file handle");
        let value = writer(&mut file)?;
        file.sync_all().map_err(|error| error.to_string())?;
        drop(file);
        std::fs::rename(&temporary, destination).map_err(|error| error.to_string())?;
        File::open(directory)
            .and_then(|directory| directory.sync_all())
            .map_err(|error| error.to_string())?;
        Ok(value)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    result
}

pub(super) fn database_file_size(path: &Path) -> DbResult<u64> {
    match std::fs::metadata(path) {
        Ok(metadata) => Ok(metadata.len()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(0),
        Err(error) => Err(error.to_string()),
    }
}
