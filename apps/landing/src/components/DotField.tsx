"use client";

import { useEffect, useRef, type CSSProperties } from "react";
import { Camera, Mesh, Plane, Program, Renderer, RenderTarget } from "ogl";
import { useStaticMotion } from "@/components/scroll/useStaticMotion";

/**
 * DotField — animated halftone dot matrix.
 *
 * Ported from the "Chromatic Waves" component: a simplex-noise field is
 * rendered to an offscreen target, then a second pass samples one texel per
 * grid cell and draws a dot whose radius tracks that cell's luminance, coloured
 * by ramping through a palette. The result is a moving dot-matrix texture — our
 * recurring brand motif, reused across sections for recognition.
 *
 * Additions over the original, because this runs several times per page rather
 * than once as a hero:
 *   - WebGL is only initialised the first time the element scrolls into view,
 *     so panels far below the fold never claim a context they don't use.
 *   - The loop pauses whenever the element leaves the viewport (a background
 *     texture nobody can see should not cost frames).
 *   - prefers-reduced-motion renders a single still frame and stops.
 */

const perlinVertexShader = `#version 300 es
in vec2 uv;
in vec2 position;
out vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position, 0., 1.);
}`;

const perlinFragmentShader = `#version 300 es
precision mediump float;
uniform float uFrequency;
uniform float uTime;
uniform float uSpeed;
uniform float uValue;
uniform vec2 uResolution;
in vec2 vUv;
out vec4 fragColor;

vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 mod289(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 permute(vec4 x) { return mod289(((x * 34.0) + 1.0) * x); }
vec4 taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }

float snoise(vec3 v) {
  const vec2  C = vec2(1.0/6.0, 1.0/3.0) ;
  const vec4  D = vec4(0.0, 0.5, 1.0, 2.0);
  vec3 i  = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);
  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min( g.xyz, l.zxy );
  vec3 i2 = max( g.xyz, l.zxy );
  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + C.yyy;
  vec3 x3 = x0 - D.yyy;
  i = mod289(i);
  vec4 p = permute( permute( permute(
             i.z + vec4(0.0, i1.z, i2.z, 1.0 ))
           + i.y + vec4(0.0, i1.y, i2.y, 1.0 ))
           + i.x + vec4(0.0, i1.x, i2.x, 1.0 ));
  float n_ = 0.142857142857;
  vec3  ns = n_ * D.wyz - D.xzx;
  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_ );
  vec4 x = x_ *ns.x + ns.yyyy;
  vec4 y = y_ *ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);
  vec4 b0 = vec4( x.xy, y.xy );
  vec4 b1 = vec4( x.zw, y.zw );
  vec4 s0 = floor(b0)*2.0 + 1.0;
  vec4 s1 = floor(b1)*2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));
  vec4 a0 = b0.xzyw + s0.xzyw*sh.xxyy ;
  vec4 a1 = b1.xzyw + s1.xzyw*sh.zzww ;
  vec3 p0 = vec3(a0.xy,h.x);
  vec3 p1 = vec3(a0.zw,h.y);
  vec3 p2 = vec3(a1.xy,h.z);
  vec3 p3 = vec3(a1.zw,h.w);
  vec4 norm = taylorInvSqrt(vec4(dot(p0,p0), dot(p1,p1), dot(p2,p2), dot(p3,p3)));
  p0 *= norm.x;
  p1 *= norm.y;
  p2 *= norm.z;
  p3 *= norm.w;
  vec4 m = max(0.6 - vec4(dot(x0,x0), dot(x1,x1), dot(x2,x2), dot(x3,x3)), 0.0);
  m = m * m;
  return 42.0 * dot( m*m, vec4( dot(p0,x0), dot(p1,x1), dot(p2,x2), dot(p3,x3) ) );
}

vec3 hsv2rgb(vec3 c) {
  vec4 K = vec4(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
  vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
  return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
}

void main() {
  vec2 uv = vUv;
  float aspect = uResolution.x / max(uResolution.y, 1.0);
  uv = (uv - 0.5) * vec2(aspect, 1.0) + 0.5;
  float hue = abs(snoise(vec3(uv * uFrequency, uTime * uSpeed)));
  vec3 rainbowColor = hsv2rgb(vec3(hue, 1.0, uValue));
  fragColor = vec4(rainbowColor, 1.0);
}`;

const dotVertexShader = perlinVertexShader;

const dotFragmentShader = `#version 300 es
precision highp float;
uniform vec2 uResolution;
uniform sampler2D uTexture;
uniform int uPaletteCount;
uniform vec3 uPalette[10];
uniform float uPaletteAlpha[10];
uniform float uCellSize;
uniform float uGamma;
uniform float uPaletteBias;
out vec4 fragColor;

void main() {
  vec2 pix = gl_FragCoord.xy;
  float cell = max(uCellSize, 1.0);

  vec2 cellIdx = floor(pix / cell);
  vec2 cellCenter = (cellIdx + 0.5) * cell;
  vec3 col = texture(uTexture, cellCenter / uResolution.xy).rgb;
  float gray = 0.3 * col.r + 0.59 * col.g + 0.11 * col.b;
  gray = pow(clamp(gray, 0.0001, 1.0), uGamma);

  vec2 cellUV = fract(pix / cell) - 0.5;
  float dist = length(cellUV);
  float radius = clamp(gray + uPaletteBias, 0.0, 1.0) * 0.5;
  float aa = fwidth(dist) + 1e-4;
  float mark = 1.0 - smoothstep(radius - aa, radius + aa, dist);

  float g2 = clamp(gray + uPaletteBias, 0.0, 1.0);
  int cnt = max(uPaletteCount, 1);
  vec3 dotCol;
  float dotOpacity;
  if (cnt <= 1) {
    dotCol = uPalette[0];
    dotOpacity = uPaletteAlpha[0];
  } else {
    float scaled = g2 * float(cnt - 1);
    int seg = int(floor(scaled));
    seg = clamp(seg, 0, cnt - 2);
    float f = clamp(scaled - float(seg), 0.0, 1.0);
    dotCol = mix(uPalette[seg], uPalette[seg + 1], f);
    dotOpacity = mix(uPaletteAlpha[seg], uPaletteAlpha[seg + 1], f);
  }
  fragColor = vec4(dotCol, mark * dotOpacity);
}`;

const MAX_COLORS = 10;

/** Brand ramp: gold glint → magenta → violet → cyan, mirroring the corona. */
const BRAND_PALETTE = ["#ffb02066", "#d61f9f99", "#9b5cffcc", "#29d8e6ff"];

function parseColor(input: string): [number, number, number, number] {
  const str = (input || "").trim();
  const rgba = str.match(
    /rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)/i
  );
  if (rgba) {
    return [
      Math.min(255, parseFloat(rgba[1]!)) / 255,
      Math.min(255, parseFloat(rgba[2]!)) / 255,
      Math.min(255, parseFloat(rgba[3]!)) / 255,
      rgba[4] === undefined ? 1 : Math.min(1, parseFloat(rgba[4])),
    ];
  }
  let hex = str.replace(/^#/, "");
  if (hex.length === 3 || hex.length === 4) {
    hex = hex
      .split("")
      .map((c) => c + c)
      .join("");
  }
  if (hex.length === 6 || hex.length === 8) {
    return [
      parseInt(hex.slice(0, 2), 16) / 255,
      parseInt(hex.slice(2, 4), 16) / 255,
      parseInt(hex.slice(4, 6), 16) / 255,
      hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1,
    ];
  }
  return [1, 1, 1, 1];
}

function buildPalette(colors: string[]) {
  const rgb: [number, number, number][] = [];
  const alpha: number[] = [];
  for (let i = 0; i < MAX_COLORS; i++) {
    const src = colors[i];
    if (src != null) {
      const [r, g, b, a] = parseColor(src);
      rgb.push([r, g, b]);
      alpha.push(a);
    } else {
      rgb.push([0, 0, 0]);
      alpha.push(0);
    }
  }
  return { rgb, alpha };
}

const mapLinear = (v: number, a: number, b: number, c: number, d: number) =>
  b === a ? c : c + ((v - a) / (b - a)) * (d - c);

interface DotFieldProps {
  /** 1–10 — noise scale (higher = finer blobs) */
  frequency?: number;
  /** 1–10 — drift speed */
  speed?: number;
  colors?: string[];
  /** 1–100 — dot grid pitch in px */
  cellSize?: number;
  /** 1–20 — contrast curve; higher = sparser dots */
  gamma?: number;
  /** −10–10 — shifts every dot bigger/smaller */
  paletteBias?: number;
  className?: string;
  style?: CSSProperties;
}

export default function DotField({
  frequency = 2,
  speed = 3,
  colors = BRAND_PALETTE,
  cellSize = 26,
  gamma = 6,
  paletteBias = -2,
  className,
  style,
}: DotFieldProps) {
  const reduced = useStaticMotion();
  const containerRef = useRef<HTMLDivElement>(null);

  // Live config, read at draw time so prop tweaks never rebuild the context.
  // Written in an effect rather than during render: the draw loop only reads it
  // from a rAF callback, which always runs after commit.
  const cfgRef = useRef({ frequency, speed, colors, cellSize, gamma, paletteBias });
  useEffect(() => {
    cfgRef.current = { frequency, speed, colors, cellSize, gamma, paletteBias };
  }, [frequency, speed, colors, cellSize, gamma, paletteBias]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let renderer: Renderer | null = null;
    let gl: Renderer["gl"] | null = null;
    let raf: number | null = null;
    let ro: ResizeObserver | null = null;
    let disposed = false;
    let visible = false;

    // Deferred init: claim a WebGL context only once this panel is on screen.
    const io = new IntersectionObserver(
      (entries) => {
        const e = entries[0];
        if (!e) return;
        visible = e.isIntersecting;
        if (visible && !renderer && !disposed) start();
        else if (visible && renderer && raf == null && !reduced) tick(performance.now());
      },
      { rootMargin: "200px" }
    );
    io.observe(container);

    let perlinProgram: Program | null = null;
    let dotProgram: Program | null = null;
    let perlinMesh: Mesh | null = null;
    let dotMesh: Mesh | null = null;
    let target: RenderTarget | null = null;
    let camera: Camera | null = null;
    let lastDraw = 0;

    const drawOnce = (timeMs: number) => {
      if (!renderer || !gl || !camera || !perlinMesh || !dotMesh || !target) return;
      if (!perlinProgram || !dotProgram) return;
      const c = cfgRef.current;
      const res: [number, number] = [gl.canvas.width, gl.canvas.height];
      perlinProgram.uniforms.uTime.value = timeMs * 0.001;
      perlinProgram.uniforms.uFrequency.value = mapLinear(c.frequency, 1, 10, 0.3, 6);
      perlinProgram.uniforms.uSpeed.value = reduced ? 0 : c.speed * 0.05;
      perlinProgram.uniforms.uResolution.value = res;
      const pal = buildPalette(c.colors);
      dotProgram.uniforms.uPaletteCount.value = Math.min(
        MAX_COLORS,
        Math.max(1, c.colors.length)
      );
      dotProgram.uniforms.uPalette.value = pal.rgb;
      dotProgram.uniforms.uPaletteAlpha.value = pal.alpha;
      dotProgram.uniforms.uCellSize.value = mapLinear(c.cellSize, 1, 100, 6, 60);
      dotProgram.uniforms.uGamma.value = mapLinear(c.gamma, 1, 20, 0.5, 8);
      dotProgram.uniforms.uPaletteBias.value = c.paletteBias * 0.05;
      dotProgram.uniforms.uResolution.value = res;
      renderer.render({ scene: perlinMesh, camera, target });
      renderer.render({ scene: dotMesh, camera });
    };

    // 30fps is plenty for a slow noise drift and halves the fill cost.
    const FRAME_MS = 1000 / 30;
    function tick(t: number) {
      if (disposed || !visible) {
        raf = null;
        return;
      }
      if (t - lastDraw >= FRAME_MS) {
        lastDraw = t;
        drawOnce(t);
      }
      raf = requestAnimationFrame(tick);
    }

    function start() {
      if (!container) return;
      renderer = new Renderer({
        dpr: Math.min(window.devicePixelRatio || 1, 1.5),
        alpha: true,
        premultipliedAlpha: false,
      });
      gl = renderer.gl;
      gl.canvas.style.position = "absolute";
      gl.canvas.style.inset = "0";
      gl.canvas.style.display = "block";
      container.appendChild(gl.canvas);

      camera = new Camera(gl, { near: 0.1, far: 100 });
      camera.position.set(0, 0, 3);

      perlinProgram = new Program(gl, {
        vertex: perlinVertexShader,
        fragment: perlinFragmentShader,
        uniforms: {
          uTime: { value: 0 },
          uFrequency: { value: 1 },
          uSpeed: { value: 0.15 },
          uValue: { value: 1 },
          uResolution: { value: [gl.canvas.width, gl.canvas.height] },
        },
      });
      perlinMesh = new Mesh(gl, {
        geometry: new Plane(gl, { width: 2, height: 2 }),
        program: perlinProgram,
      });

      target = new RenderTarget(gl);

      const pal = buildPalette(cfgRef.current.colors);
      dotProgram = new Program(gl, {
        vertex: dotVertexShader,
        fragment: dotFragmentShader,
        uniforms: {
          uResolution: { value: [gl.canvas.width, gl.canvas.height] },
          uTexture: { value: target.texture },
          uPaletteCount: { value: cfgRef.current.colors.length },
          uPalette: { value: pal.rgb },
          uPaletteAlpha: { value: pal.alpha },
          uCellSize: { value: 26 },
          uGamma: { value: 3 },
          uPaletteBias: { value: -0.1 },
        },
      });
      dotMesh = new Mesh(gl, {
        geometry: new Plane(gl, { width: 2, height: 2 }),
        program: dotProgram,
      });

      const resize = () => {
        if (!renderer || !gl || !camera || !container) return;
        const w = container.clientWidth || 1;
        const h = container.clientHeight || 1;
        renderer.setSize(w, h);
        camera.perspective({ aspect: gl.canvas.width / gl.canvas.height });
        target?.setSize(gl.canvas.width, gl.canvas.height);
        drawOnce(lastDraw || performance.now());
      };
      resize();
      ro = new ResizeObserver(resize);
      ro.observe(container);

      if (reduced) drawOnce(0);
      else raf = requestAnimationFrame(tick);
    }

    return () => {
      disposed = true;
      io.disconnect();
      ro?.disconnect();
      if (raf != null) cancelAnimationFrame(raf);
      if (gl?.canvas.parentElement === container) container.removeChild(gl.canvas);
      // Release the context explicitly — several of these per page, and the
      // browser only allows a handful before it starts evicting them.
      gl?.getExtension("WEBGL_lose_context")?.loseContext();
      renderer = null;
      gl = null;
    };
  }, [reduced]);

  return (
    <div
      ref={containerRef}
      aria-hidden
      className={className}
      style={{ position: "absolute", inset: 0, overflow: "hidden", ...style }}
    />
  );
}
