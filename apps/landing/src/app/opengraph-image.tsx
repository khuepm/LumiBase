import { ImageResponse } from "next/og";

export const dynamic = "force-static";

export const alt = "LumiBase - Edge-Native Headless CMS built on Cloudflare Workers";
export const size = {
  width: 1200,
  height: 630,
};
export const contentType = "image/png";

export default function Image() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          background: "linear-gradient(135deg, #0f172a 0%, #1e3a8a 100%)",
          color: "white",
          fontFamily: "sans-serif",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 24,
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              width: 96,
              height: 96,
              borderRadius: 24,
              background: "#2563eb",
              fontSize: 64,
              fontWeight: 700,
            }}
          >
            L
          </div>
          <div style={{ fontSize: 80, fontWeight: 700 }}>LumiBase</div>
        </div>
        <div
          style={{
            marginTop: 32,
            fontSize: 36,
            color: "#bfdbfe",
          }}
        >
          Edge-Native Headless CMS
        </div>
        <div
          style={{
            marginTop: 16,
            fontSize: 24,
            color: "#93c5fd",
          }}
        >
          Open-source · Cloudflare Workers · Privacy-first
        </div>
      </div>
    ),
    {
      ...size,
    }
  );
}
