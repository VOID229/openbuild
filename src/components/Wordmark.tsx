import openbotsSvg from "../assets/brand/openbots-wordmark.svg" with { type: "text" };
import openbuildSvg from "../assets/brand/openbuild-wordmark.svg" with { type: "text" };
import { cx } from "../lib/ui";

// The brushstroke lockups from design/brush-mark. They draw in currentColor and scale with the font size.
const BRANDS = {
  openbuild: { label: "OpenBuild", svg: openbuildSvg },
  openbots: { label: "OpenBots", svg: openbotsSvg },
};

export function Wordmark({ brand, className }: { brand: keyof typeof BRANDS; className?: string }) {
  const { label, svg } = BRANDS[brand];
  return (
    <span className={cx("wordmark", className)}>
      <span className="wordmark-art" aria-hidden dangerouslySetInnerHTML={{ __html: svg }} />
      {/* The name stays as text for screen readers, search and copy. */}
      <span className="wordmark-label">{label}</span>
    </span>
  );
}
