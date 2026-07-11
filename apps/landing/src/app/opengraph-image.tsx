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
          background: "#100904",
          color: "#ffedd7",
          fontFamily: "monospace",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 40 }}>
          {/* Eclipse mark — corona + moon at totality */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              width: 150,
              height: 150,
              borderRadius: 9999,
              background:
                "radial-gradient(circle, rgba(255,160,0,0.5) 40%, rgba(230,80,10,0.25) 60%, rgba(230,80,10,0) 75%)",
            }}
          >
            <div
              style={{
                display: "flex",
                width: 96,
                height: 96,
                borderRadius: 9999,
                background: "#150c05",
                boxShadow:
                  "0 0 0 3px #ffa000, 0 0 40px rgba(230,80,10,0.8), 0 0 90px rgba(230,80,10,0.4)",
              }}
            />
          </div>
          <div style={{ display: "flex", fontSize: 84, fontWeight: 700 }}>
            <span>LUMI</span>
            <span style={{ color: "#e6500a" }}>BASE</span>
          </div>
        </div>
        <div
          style={{
            marginTop: 36,
            fontSize: 38,
            color: "#ffedd7",
          }}
        >
          THE CONTENT OPERATING SYSTEM
        </div>
        <div
          style={{
            marginTop: 18,
            fontSize: 22,
            letterSpacing: 3,
            color: "rgba(255,237,215,0.55)",
          }}
        >
          [ DECLARE INTENT · AGENTS RECONCILE · YOU KEEP THE VETO ]
        </div>
      </div>
    ),
    {
      ...size,
    }
  );
}
