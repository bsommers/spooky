// Hand-authored icon set (original artwork). Every glyph draws with `currentColor`, so a theme recolors it through
// text/accent tokens alone. Decorative by default (aria-hidden); pass `title` to expose one as an image with a name.
import type { ReactNode, SVGProps } from 'react';

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'children' | 'title'> {
  size?: number;
  title?: string;
}

function make(name: string, body: ReactNode, filled = false) {
  function Icon({ size = 20, title, ...rest }: IconProps) {
    const a11y = title === undefined ? { 'aria-hidden': true as const } : { role: 'img' as const, 'aria-label': title };
    return (
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 24 24"
        width={size}
        height={size}
        fill={filled ? 'currentColor' : 'none'}
        stroke={filled ? 'none' : 'currentColor'}
        strokeWidth={1.75}
        strokeLinecap="round"
        strokeLinejoin="round"
        focusable="false"
        data-icon={name}
        {...a11y}
        {...rest}
      >
        {body}
      </svg>
    );
  }
  Icon.displayName = `${name[0]?.toUpperCase() ?? ''}${name.slice(1)}Icon`;
  return Icon;
}

export const NavIcon = make('nav', <path d="M4 6.5h16M4 12h16M4 17.5h16" />);
export const PawIcon = make(
  'paw',
  <>
    <path d="M12 12.4c-2.7 0-5.1 2.3-5.1 4.7 0 1.6 1.2 2.4 2.7 2.4.9 0 1.5-.4 2.4-.4s1.5.4 2.4.4c1.5 0 2.7-.8 2.7-2.4 0-2.4-2.4-4.7-5.1-4.7z" />
    <ellipse cx="5.4" cy="10.2" rx="1.6" ry="2.1" />
    <ellipse cx="9.4" cy="6.3" rx="1.7" ry="2.3" />
    <ellipse cx="14.6" cy="6.3" rx="1.7" ry="2.3" />
    <ellipse cx="18.6" cy="10.2" rx="1.6" ry="2.1" />
  </>,
  true,
);
export const WhiskerIcon = make('whisker', <path d="M3.5 8.5c4.5-.7 8.5-.2 13 2M3.5 12.5h13M3.5 16.5c4.5.7 8.5.2 13-2" />);
export const MoonIcon = make('moon', <path d="M20 14.6A8 8 0 0 1 9.4 4 8 8 0 1 0 20 14.6z" />);
export const EyeIcon = make(
  'eye',
  <>
    <path d="M2 12c3-5 6-7 10-7s7 2 10 7c-3 5-6 7-10 7S5 17 2 12z" />
    <path d="M12 8.2v7.6" strokeWidth={2.4} />
  </>,
);
export const CopyIcon = make(
  'copy',
  <>
    <rect x="9" y="9" width="11" height="11" rx="2" />
    <path d="M5 15V6a2 2 0 0 1 2-2h9" />
  </>,
);
export const CheckIcon = make('check', <path d="M5 12.5l4.5 4.5L19 7.5" />);
export const WarningIcon = make(
  'warning',
  <>
    <path d="M12 3.5l9.5 16.5h-19z" />
    <path d="M12 10v4.5M12 17.4h.01" />
  </>,
);
export const GearIcon = make(
  'gear',
  <>
    <circle cx="12" cy="12" r="5.5" />
    <circle cx="12" cy="12" r="2" />
    <path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1" />
  </>,
);
export const PlayIcon = make('play', <path d="M7 4.5v15l12-7.5z" />);

/** Internal (not part of the gallery): the select chevron, drawn rather than typed so no system font is involved. */
export const ChevronIcon = make('chevron', <path d="M6 9.5l6 6 6-6" />);

export const ICONS = {
  nav: NavIcon,
  paw: PawIcon,
  whisker: WhiskerIcon,
  moon: MoonIcon,
  eye: EyeIcon,
  copy: CopyIcon,
  check: CheckIcon,
  warning: WarningIcon,
  gear: GearIcon,
  play: PlayIcon,
} as const;
export type IconName = keyof typeof ICONS;

/** The cat-eye mark. Colors come from `--gw-accent` / `--gw-bg` through CSS, so each theme draws it in its own palette. */
export function LogoMark({ size = 32 }: { size?: number }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 40" width={size} height={(size * 40) / 64} aria-hidden="true" focusable="false" className="gw-logo-mark">
      <path className="gw-logo-mark__eye" d="M2 20C10 8 20 3 32 3s22 5 30 17c-8 12-18 17-30 17S10 32 2 20z" />
      <ellipse className="gw-logo-mark__pupil" cx="32" cy="20" rx="4.6" ry="14" />
    </svg>
  );
}

/** Mark plus the name in the theme's display font. */
export function Wordmark() {
  return (
    <span className="gw-wordmark">
      <LogoMark />
      <span className="gw-wordmark__text">Spooky</span>
    </span>
  );
}
