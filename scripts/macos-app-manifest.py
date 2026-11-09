#!/usr/bin/env python3

import hashlib
import json
import os
import stat
import sys
import time


READ_SIZE = 64 * 1024
HOOK_TIMEOUT_SECONDS = 10
HOOK_ENVIRONMENT_KEYS = (
    "INEED_TEST_MANIFEST_HOOK_PHASE",
    "INEED_TEST_MANIFEST_HOOK_RELATIVE_PATH",
    "INEED_TEST_MANIFEST_READY_FILE",
    "INEED_TEST_MANIFEST_CONTINUE_FILE",
)


class ManifestError(Exception):
    pass


def metadata_tuple(metadata):
    return (
        metadata.st_dev,
        metadata.st_ino,
        stat.S_IMODE(metadata.st_mode),
        metadata.st_size,
        metadata.st_mtime_ns,
        metadata.st_ctime_ns,
    )


def require_same_metadata(expected, actual, relative_path, subject):
    if metadata_tuple(expected) != metadata_tuple(actual):
        raise ManifestError(
            "App entry {} changed {} metadata during inspection".format(
                relative_path or ".", subject
            )
        )


def close_preserving(fd, label, primary_error):
    try:
        os.close(fd)
    except OSError as close_error:
        if primary_error is not None:
            return ManifestError(
                "{}; additionally failed to close {}: {}".format(
                    primary_error, label, close_error
                )
            )
        return ManifestError("Failed to close {}: {}".format(label, close_error))
    return primary_error


def maybe_run_test_hook(phase, relative_path):
    configured_phase = os.environ.get(HOOK_ENVIRONMENT_KEYS[0])
    configured_relative_path = os.environ.get(HOOK_ENVIRONMENT_KEYS[1], "")
    if configured_phase != phase or configured_relative_path != relative_path:
        return

    ready_path = os.environ.get(HOOK_ENVIRONMENT_KEYS[2])
    continue_path = os.environ.get(HOOK_ENVIRONMENT_KEYS[3])
    if (
        not ready_path
        or not continue_path
        or not os.path.isabs(ready_path)
        or not os.path.isabs(continue_path)
    ):
        raise ManifestError("Test synchronization paths must be absolute")

    ready_fd = os.open(ready_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    os.close(ready_fd)
    deadline = time.monotonic() + HOOK_TIMEOUT_SECONDS
    while not os.path.exists(continue_path):
        if time.monotonic() >= deadline:
            raise ManifestError("Timed out waiting for test synchronization")
        time.sleep(0.01)


def child_relative_path(parent_relative_path, name):
    if parent_relative_path:
        return parent_relative_path + "/" + name
    return name


def describe_unsupported_type(mode):
    if stat.S_ISSOCK(mode):
        return "socket"
    if stat.S_ISFIFO(mode):
        return "FIFO"
    if stat.S_ISBLK(mode):
        return "block device"
    if stat.S_ISCHR(mode):
        return "character device"
    return "unknown file type"


def inspect_symlink(parent_fd, name, relative_path, classified_metadata):
    target = os.readlink(name, dir_fd=parent_fd)
    final_metadata = os.stat(
        name,
        dir_fd=parent_fd,
        follow_symlinks=False,
    )
    if not stat.S_ISLNK(final_metadata.st_mode):
        raise ManifestError(
            "App symlink {} was replaced during inspection".format(relative_path)
        )
    require_same_metadata(
        classified_metadata,
        final_metadata,
        relative_path,
        "symlink",
    )
    return {"path": relative_path, "type": "symlink", "target": target}


def inspect_regular_file(parent_fd, name, relative_path, classified_metadata):
    maybe_run_test_hook("before_file_open", relative_path)
    flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK
    if hasattr(os, "O_CLOEXEC"):
        flags |= os.O_CLOEXEC
    file_fd = os.open(name, flags, dir_fd=parent_fd)
    primary_error = None
    result = None
    try:
        before_metadata = os.fstat(file_fd)
        if not stat.S_ISREG(before_metadata.st_mode):
            raise ManifestError(
                "App entry {} changed type while opening regular file".format(
                    relative_path
                )
            )
        require_same_metadata(
            classified_metadata,
            before_metadata,
            relative_path,
            "file-open",
        )
        maybe_run_test_hook("after_file_open", relative_path)

        digest = hashlib.sha256()
        bytes_read = 0
        hook_ran = False
        while True:
            chunk = os.read(file_fd, READ_SIZE)
            if not chunk:
                break
            digest.update(chunk)
            bytes_read += len(chunk)
            if not hook_ran:
                maybe_run_test_hook("during_file_hash", relative_path)
                hook_ran = True

        after_metadata = os.fstat(file_fd)
        require_same_metadata(
            before_metadata,
            after_metadata,
            relative_path,
            "file",
        )
        if bytes_read != before_metadata.st_size:
            raise ManifestError(
                "App file {} byte count changed: expected {}, read {}".format(
                    relative_path, before_metadata.st_size, bytes_read
                )
            )

        path_metadata = os.stat(
            name,
            dir_fd=parent_fd,
            follow_symlinks=False,
        )
        if not stat.S_ISREG(path_metadata.st_mode):
            raise ManifestError(
                "App file {} pathname was replaced during inspection".format(
                    relative_path
                )
            )
        require_same_metadata(
            after_metadata,
            path_metadata,
            relative_path,
            "pathname",
        )
        result = {
            "path": relative_path,
            "type": "file",
            "mode": stat.S_IMODE(before_metadata.st_mode),
            "bytes": bytes_read,
            "sha256": digest.hexdigest(),
        }
    except BaseException as error:
        primary_error = error
    finally:
        primary_error = close_preserving(
            file_fd,
            "app file {}".format(relative_path),
            primary_error,
        )
    if primary_error is not None:
        raise primary_error
    return result


def inspect_directory(parent_fd, name, relative_path, classified_metadata, manifest):
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    if hasattr(os, "O_CLOEXEC"):
        flags |= os.O_CLOEXEC
    directory_fd = os.open(name, flags, dir_fd=parent_fd)
    primary_error = None
    try:
        opened_metadata = os.fstat(directory_fd)
        if not stat.S_ISDIR(opened_metadata.st_mode):
            raise ManifestError(
                "App entry {} changed type while opening directory".format(relative_path)
            )
        require_same_metadata(
            classified_metadata,
            opened_metadata,
            relative_path,
            "directory-open",
        )
        maybe_run_test_hook("after_directory_open", relative_path)
        manifest.append(
            {
                "path": relative_path,
                "type": "directory",
                "mode": stat.S_IMODE(opened_metadata.st_mode),
            }
        )
        inspect_directory_entries(directory_fd, relative_path, manifest)

        after_metadata = os.fstat(directory_fd)
        require_same_metadata(
            opened_metadata,
            after_metadata,
            relative_path,
            "directory",
        )
        path_metadata = os.stat(
            name,
            dir_fd=parent_fd,
            follow_symlinks=False,
        )
        if not stat.S_ISDIR(path_metadata.st_mode):
            raise ManifestError(
                "App directory {} pathname was replaced during inspection".format(
                    relative_path
                )
            )
        require_same_metadata(
            after_metadata,
            path_metadata,
            relative_path,
            "directory-pathname",
        )
    except BaseException as error:
        primary_error = error
    finally:
        primary_error = close_preserving(
            directory_fd,
            "app directory {}".format(relative_path),
            primary_error,
        )
    if primary_error is not None:
        raise primary_error


def inspect_directory_entries(directory_fd, parent_relative_path, manifest):
    with os.scandir(directory_fd) as iterator:
        names = sorted(entry.name for entry in iterator)

    for name in names:
        relative_path = child_relative_path(parent_relative_path, name)
        classified_metadata = os.stat(
            name,
            dir_fd=directory_fd,
            follow_symlinks=False,
        )
        mode = classified_metadata.st_mode
        if stat.S_ISDIR(mode):
            inspect_directory(
                directory_fd,
                name,
                relative_path,
                classified_metadata,
                manifest,
            )
        elif stat.S_ISREG(mode):
            manifest.append(
                inspect_regular_file(
                    directory_fd,
                    name,
                    relative_path,
                    classified_metadata,
                )
            )
        elif stat.S_ISLNK(mode):
            manifest.append(
                inspect_symlink(
                    directory_fd,
                    name,
                    relative_path,
                    classified_metadata,
                )
            )
        else:
            raise ManifestError(
                "Unsupported app entry {}: {}".format(
                    relative_path, describe_unsupported_type(mode)
                )
            )


def create_manifest(app_path):
    if not os.path.isabs(app_path):
        raise ManifestError("App root path must be absolute")
    try:
        classified_root = os.stat(app_path, follow_symlinks=False)
    except FileNotFoundError as error:
        raise ManifestError("App root is missing: {}".format(app_path)) from error
    if stat.S_ISLNK(classified_root.st_mode):
        raise ManifestError("App root must not be a symbolic link: {}".format(app_path))
    if not stat.S_ISDIR(classified_root.st_mode):
        raise ManifestError("App root must be a directory: {}".format(app_path))

    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    if hasattr(os, "O_CLOEXEC"):
        flags |= os.O_CLOEXEC
    root_fd = os.open(app_path, flags)
    primary_error = None
    manifest = []
    try:
        opened_root = os.fstat(root_fd)
        if not stat.S_ISDIR(opened_root.st_mode):
            raise ManifestError("App root descriptor is not a directory")
        require_same_metadata(classified_root, opened_root, "", "root-open")
        maybe_run_test_hook("after_root_open", "")
        manifest.append(
            {
                "path": ".",
                "type": "directory",
                "mode": stat.S_IMODE(opened_root.st_mode),
            }
        )
        inspect_directory_entries(root_fd, "", manifest)

        final_root_fd = os.fstat(root_fd)
        require_same_metadata(opened_root, final_root_fd, "", "root")
        final_root_path = os.stat(app_path, follow_symlinks=False)
        if not stat.S_ISDIR(final_root_path.st_mode):
            raise ManifestError("App root pathname was replaced during inspection")
        require_same_metadata(opened_root, final_root_path, "", "root-pathname")
    except BaseException as error:
        primary_error = error
    finally:
        primary_error = close_preserving(root_fd, "app root", primary_error)
    if primary_error is not None:
        raise primary_error
    return sorted(manifest, key=lambda entry: entry["path"])


def main():
    if len(sys.argv) != 2 or not os.path.isabs(sys.argv[1]):
        print("Usage: macos-app-manifest.py /absolute/path/to/App.app", file=sys.stderr)
        return 2
    try:
        manifest = create_manifest(sys.argv[1])
    except Exception as error:
        print(str(error), file=sys.stderr)
        return 1
    json.dump(manifest, sys.stdout, ensure_ascii=False, separators=(",", ":"))
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
