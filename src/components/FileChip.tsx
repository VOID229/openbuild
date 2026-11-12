import { File, FileArchive, FileAudio, FileText, FileVideo, Image } from "lucide-react";
import { fileKind, formatBytes } from "../../shared/attachments";
import { useUploadProgress } from "../lib/localFiles";
import { cx } from "../lib/ui";

const ICONS = { image: Image, audio: FileAudio, video: FileVideo, archive: FileArchive, text: FileText, file: File };

/**
 * An attached file that isn't shown as a picture: its kind, name and size. With `href` it opens the
 * file (a song or video plays in the browser, anything else is saved); `progress` is an upload under
 * way; `note` replaces the size (why it can't be sent, or that it wasn't).
 */

/** A message's file: uploading while its message is being sent, a link once it's on the agent's machine. */
export function SentFileChip({ file, href, className }: { file: { id: string; name: string; mime: string; size: number; local?: boolean }; href?: string; className?: string }) {
  const progress = useUploadProgress(file.id);
  const waiting = file.local && progress == null;
  return <FileChip className={className} name={file.name} mime={file.mime} size={file.size} progress={progress} href={file.local || progress != null ? undefined : href} note={waiting ? "Waiting to upload" : undefined} />;
}

export function FileChip({ name, mime, size, href, progress, note, className }: { name: string; mime: string; size: number; href?: string; progress?: number; note?: string; className?: string }) {
  const Icon = ICONS[fileKind(mime, name)];
  const body = (
    <>
      <Icon size={16} />
      <span>
        <span className="attachment-name">{name}</span>
        <span className="attachment-meta">{note ?? (progress == null ? formatBytes(size) : `Uploading · ${Math.floor((progress / Math.max(size, 1)) * 100)}%`)}</span>
      </span>
      {progress != null && <span className="attachment-progress" style={{ width: `${(progress / Math.max(size, 1)) * 100}%` }} />}
    </>
  );
  return href ? (
    <a className={cx("attachment-file attachment-link", className)} href={href} target="_blank" rel="noreferrer" title={`Open ${name}`}>
      {body}
    </a>
  ) : (
    <span className={cx("attachment-file", className)} title={name}>
      {body}
    </span>
  );
}
