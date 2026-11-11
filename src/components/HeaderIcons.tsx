// The sidebars' header icons: rounder and a touch heavier than Lucide's, so the row's few marks
// carry it.
import type { ReactNode } from "react";

const Icon = ({ size = 18, children }: { size?: number; children: ReactNode }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    {children}
  </svg>
);

export const PanelIcon = ({ size }: { size?: number }) => (
  <Icon size={size}>
    <rect x="3" y="4" width="18" height="16" rx="4" />
    <path d="M9.5 4v16" />
  </Icon>
);

export const SearchIcon = ({ size }: { size?: number }) => (
  <Icon size={size}>
    <circle cx="11" cy="11" r="7" />
    <path d="m20 20-3.5-3.5" />
  </Icon>
);

export const FilterIcon = ({ size }: { size?: number }) => (
  <Icon size={size}>
    <path d="M4 7h16M7 12h10M10 17h4" />
  </Icon>
);

export const PlusIcon = ({ size }: { size?: number }) => (
  <Icon size={size}>
    <path d="M12 5v14M5 12h14" />
  </Icon>
);
