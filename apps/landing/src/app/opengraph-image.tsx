import { ImageResponse } from "next/og";

export const dynamic = "force-static";

export const alt = "LumiBase — The Content Operating System";
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
          background: "#05070a",
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
          {/* Sphere mark — matches the site header (white→grey orb, violet glow). */}
          <div
            style={{
              width: 88,
              height: 88,
              borderRadius: "50%",
              background: "linear-gradient(180deg, #ffffff 0%, #cfcfcf 100%)",
              boxShadow: "0 0 48px rgba(123,97,255,0.75)",
            }}
          />
          <div style={{ display: "flex", fontSize: 80, fontWeight: 700 }}>
            <span>Lumi</span>
            <span style={{ color: "#7B61FF" }}>Base</span>
          </div>
        </div>
        <div
          style={{
            marginTop: 32,
            fontSize: 40,
            color: "#e6edf3",
          }}
        >
          The Content Operating System
        </div>
        <div
          style={{
            marginTop: 16,
            fontSize: 24,
            color: "#8b98a9",
          }}
        >
          Declare intent · Agents reconcile · You keep the veto
        </div>
      </div>
    ),
    {
      ...size,
    }
  );
}
