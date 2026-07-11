"use client";

import Link from "next/link";
import { motion, useScroll, useTransform } from "framer-motion";
import { EclipseMark } from "@/components/EclipseMark";

/**
 * Hero — opening scene of the scroll-cinema. The eclipse itself lives on the
 * fixed EclipseStage behind this; the headline block parallaxes out as the
 * stage shrinks toward the top-right.
 */
export default function Hero() {
  const { scrollYProgress } = useScroll();
  const yOut = useTransform(scrollYProgress, [0, 0.08], [0, -120]);
  const opacityOut = useTransform(scrollYProgress, [0, 0.07], [1, 0]);

  return (
    <section className="relative min-h-[150vh] px-5">
      <div className="sticky top-0 flex h-screen flex-col items-center pt-[13vh] text-center md:pt-[15vh]">
        <motion.div style={{ y: yOut, opacity: opacityOut }}>
          <p className="label-mono m-0">
            [ THE CONTENT OPERATING SYSTEM · TOTALITY&nbsp;EDITION ]
          </p>
          <h1
            className="mx-auto mb-0 mt-5 max-w-[900px] uppercase [font:800_44px/48px_var(--font-sans)] sm:[font:800_62px/64px_var(--font-sans)] md:[font:800_80px/80px_var(--font-sans)]"
            style={{ letterSpacing: "-0.01em", color: "var(--foreground)" }}
          >
            Your content,
            <br />
            operated by{" "}
            <span style={{ color: "var(--color-accent)" }}>AI.</span>
          </h1>
          <p
            className="font-serif-body mx-auto mt-6 max-w-[470px]"
            style={{
              font: "400 19px/31px var(--font-serif-stack)",
              color: "var(--color-text-secondary)",
            }}
          >
            LumiBase is the Content Operating System — agents do the
            operational work, you set the intent and hold the veto.
          </p>
          <div className="mt-8 flex justify-center gap-3">
            <Link
              href="https://github.com/khuepm/lumibase"
              target="_blank"
              rel="noopener noreferrer"
              className="btn-pill btn-solid btn-md"
            >
              <span>Start building</span>
            </Link>
            <Link
              href="https://docs.lumibase.dev"
              target="_blank"
              rel="noopener noreferrer"
              className="btn-pill btn-glass h-[46px] pl-4 pr-5 text-sm"
            >
              <EclipseMark size={20} />
              <span>Read the docs</span>
            </Link>
          </div>
        </motion.div>
      </div>
    </section>
  );
}
