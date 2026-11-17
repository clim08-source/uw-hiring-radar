import { ImageResponse } from "next/og";

// Home-screen icon for iOS, drawn to match app/icon.svg.
export const size = { width: 180, height: 180 };
export const contentType = "image/png";

export default function AppleIcon() {
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", background: "#fdd54f" }}>
        <svg width="132" height="132" viewBox="0 0 64 64">
          <g fill="none" stroke="#1a1500" strokeWidth="4" strokeLinecap="round">
            <circle cx="32" cy="32" r="19" />
            <circle cx="32" cy="32" r="10" />
            <path d="M32 32 45.5 18.5" />
          </g>
          <circle cx="32" cy="32" r="3.5" fill="#1a1500" />
          <circle cx="45.5" cy="18.5" r="4" fill="#1a1500" />
        </svg>
      </div>
    ),
    size,
  );
}
