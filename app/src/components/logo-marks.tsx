type MarkProps = { size?: number; className?: string };

/** The Veritas mark — direction 1B: a price-pulse V diving into the settlement
    print (the glowing vertex, sitting on the dashed target line) and rebounding.
    The dot is the mechanism: the first print after expiry decides everything.
    Two variants: "full" carries the detail (area fill, target dash, print dot)
    and is used at small sizes; "hero" is the pure thick glowing trace, used at
    display size where the details would read as clutter. */
export function PulseAreaMark({ size = 32, className, variant = "full" }: MarkProps & { variant?: "full" | "hero" }) {
  if (variant === "hero") {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 48 48"
        fill="none"
        className={className}
        style={{ filter: "drop-shadow(0 0 15px rgba(34, 211, 238, 0.5))" }}
        aria-hidden
      >
        <polyline
          points="4,9 13,15 24,38 35,20 44,6"
          stroke="#22d3ee"
          strokeWidth="6.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" fill="none" className={className} aria-hidden>
      <path d="M4 9 L13 15 L24 38 L35 20 L44 6 L44 45 L4 45 Z" fill="#22d3ee" opacity="0.15" />
      <line x1="2" y1="38" x2="46" y2="38" stroke="#94a3b8" strokeWidth="1.6" strokeDasharray="3.5 3.5" opacity="0.55" />
      <polyline
        points="4,9 13,15 24,38 35,20 44,6"
        stroke="#22d3ee"
        strokeWidth="5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="24" cy="38" r="9" fill="#22d3ee" opacity="0.22" />
      <circle cx="24" cy="38" r="4" fill="#cffafe" />
    </svg>
  );
}
