import { File, FileArchive, FileAudio, FileText, FileVideo, Image } from "lucide-react";
import { fileKind, formatBytes } from "../../shared/attachments";
import { cx } from "../lib/ui";

const ICONS = { image: Image, audio: FileAudio, video: FileVideo, archive: FileArchive, text: FileText, file: File };

/**
 * An attached file that isn't shown as a picture: its kind, name and size. With `href` it opens the
 * file (a song or video plays in the browser, anything else is saved); `progress` is an upload under way.
 */
export function FileChip({ name, mime, size, href, progress, className }: { name: string; mime: string; size: number; href?: string; progress?: number; className?: string }) {
  const Icon = ICONS[fileKind(mime, name)];
  const body = (
    <>
      <Icon size={16} />
      <span>
        <span className="attachment-name">{name}</span>
        <span className="attachment-meta">{progress == null ? formatBytes(size) : `Uploading · ${Math.floor((progress / Math.max(size, 1)) * 100)}%`}</span>
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
