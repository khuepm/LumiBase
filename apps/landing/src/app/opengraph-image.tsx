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
          background: "#07060c",
          color: "#f4ecff",
          fontFamily: "monospace",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 40 }}>
          {/* Eclipse mark — prismatic corona + moon at totality */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              width: 150,
              height: 150,
              borderRadius: 9999,
              background:
                "radial-gradient(circle, rgba(255,176,32,0.45) 34%, rgba(214,31,159,0.3) 55%, rgba(155,92,255,0.22) 68%, rgba(41,216,230,0) 80%)",
            }}
          >
            <div
              style={{
                display: "flex",
                width: 96,
                height: 96,
                borderRadius: 9999,
                background: "#0d0c14",
                boxShadow:
                  "0 0 0 3px #ffb020, 0 0 40px rgba(214,31,159,0.75), 0 0 90px rgba(155,92,255,0.5)",
              }}
            />
          </div>
          <div style={{ display: "flex", fontSize: 84, fontWeight: 700 }}>
            <span>LUMI</span>
            <span
              style={{
                background: "linear-gradient(120deg,#b06bff,#d61f9f,#ff6a1a)",
                backgroundClip: "text",
                color: "transparent",
              }}
            >
              BASE
            </span>
          </div>
        </div>
        <div
          style={{
            marginTop: 36,
            fontSize: 38,
            color: "#f4ecff",
          }}
        >
          THE CONTENT OPERATING SYSTEM
        </div>
        <div
          style={{
            marginTop: 18,
            fontSize: 22,
            letterSpacing: 3,
            color: "rgba(244,236,255,0.55)",
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
