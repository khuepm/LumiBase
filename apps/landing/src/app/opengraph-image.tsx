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
          fontFamily: "monospace",
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
              borderRadius: 20,
              background: "rgba(34,197,94,0.12)",
              border: "2px solid rgba(34,197,94,0.4)",
              fontSize: 60,
              fontWeight: 700,
              color: "#4ade80",
            }}
          >
            {">_"}
          </div>
          <div style={{ display: "flex", fontSize: 80, fontWeight: 700 }}>
            <span>Lumi</span>
            <span style={{ color: "#4ade80" }}>Base</span>
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
