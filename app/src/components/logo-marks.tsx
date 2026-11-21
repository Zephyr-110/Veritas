type MarkProps = { size?: number; className?: string };

/**
 * The Veritas mark — a price-pulse V touching the settlement print
 * on the target threshold line and rebounding. Pure monochrome so it
 * adapts cleanly across dark and light surfaces.
 */
export function PulseAreaMark({ size = 32, className, variant = "full" }: MarkProps & { variant?: "full" | "hero" }) {
  if (variant === "hero") {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 48 48"
        fill="none"
        className={className}
        aria-hidden
      >
        <polyline
          points="4,9 13,15 24,38 35,20 44,6"
          stroke="currentColor"
          strokeWidth="6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" fill="none" className={className} aria-hidden>
      <path d="M4 9 L13 15 L24 38 L35 20 L44 6 L44 45 L4 45 Z" fill="currentColor" opacity="0.1" />
      <line x1="2" y1="38" x2="46" y2="38" stroke="currentColor" strokeWidth="1.5" strokeDasharray="3.5 3.5" opacity="0.4" />
      <polyline
        points="4,9 13,15 24,38 35,20 44,6"
        stroke="currentColor"
        strokeWidth="4.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="24" cy="38" r="8" fill="currentColor" opacity="0.16" />
      <circle cx="24" cy="38" r="3.5" fill="currentColor" />
    </svg>
  );
}
