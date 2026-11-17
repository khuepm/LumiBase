"use client";

// TEMPORARY lab route for iterating on the mascot. Removed before commit.
import { useEffect, useRef } from "react";
import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { createLumi } from "@/components/storybook/scene/lumi";

export default function LumiLab() {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    renderer.setPixelRatio(1);
    renderer.setSize(innerWidth, innerHeight);
    renderer.toneMapping = THREE.NeutralToneMapping;
    const scene = new THREE.Scene();
    const params = new URLSearchParams(location.search);
    scene.background = new THREE.Color(params.get("bg") ?? "#141033");
    const pmrem = new THREE.PMREMGenerator(renderer);
    scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    const camera = new THREE.PerspectiveCamera(35, innerWidth / innerHeight, 0.1, 100);
    camera.position.set(0, 0, Number(params.get("z") ?? 6));
    const lumi = createLumi({ shells: Number(params.get("shells") ?? 44) });
    lumi.group.rotation.y = Number(params.get("ry") ?? 0);
    scene.add(lumi.group);
    const pose = {
      velocity: new THREE.Vector3(Number(params.get("vx") ?? 0), 0, 0),
      look: new THREE.Vector2(Number(params.get("lx") ?? 0), Number(params.get("ly") ?? 0)),
      glow: 1,
      underlight: Number(params.get("under") ?? 0),
      stretch: Number(params.get("stretch") ?? 1),
      squint: params.has("squint"),
    };
    let raf = 0;
    let last = performance.now();
    const start = last;
    const loop = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      lumi.update(dt, (now - start) / 1000, pose);
      renderer.render(scene, camera);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      lumi.dispose();
      renderer.dispose();
    };
  }, []);
  return <canvas ref={ref} style={{ position: "fixed", inset: 0, zIndex: 100 }} />;
}
