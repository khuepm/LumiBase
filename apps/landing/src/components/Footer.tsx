import type { CSSProperties } from "react";
import Link from "next/link";
import { ArrowUpRight, MessageCircle } from "lucide-react";
import FooterMotion from "@/components/FooterMotion";
import styles from "./Footer.module.css";

const productLinks = [
  { label: "AI Harness", href: "/#ai-harness" },
  { label: "Content OS", href: "/#content-os" },
  { label: "Studio", href: "/#studio" },
  { label: "Runtime", href: "/#runtime" },
];
const legalLinks = [
  { label: "Privacy", href: "/privacy" },
  { label: "Terms", href: "/tos" },
  { label: "Apache 2.0", href: "/license" },
];

function delay(index: number, stagger: number): CSSProperties {
  return { "--reveal-delay": `${index * stagger}s` } as CSSProperties;
}

export default function Footer() {
  return (
    <FooterMotion className={styles.footer}>
      <div className={styles.backdrop} aria-hidden="true">
        <video
          className={styles.video}
          data-footer-video
          data-src="https://api.getlayers.ai/storage/v1/object/public/public/assets/loopstack-f8c64439bf/flower.mp4"
          poster="/assets/footer-flower.jpg"
          preload="none"
          muted
          loop
          playsInline
          tabIndex={-1}
        />
      </div>

      <div className={styles.hero}>
        <p className={styles.eyebrow}>A new era of content starts here</p>
        <h2 className={styles.headline} aria-label="Your next chapter. Built with LumiBase.">
          {["Your next chapter.", "Built with LumiBase."].map((line, lineIndex) => (
            <span className={styles.headlineLine} key={line} aria-hidden="true">
              {line.split(" ").map((word, index) => (
                <span className={styles.wordMask} key={word}>
                  <span className={styles.word} style={delay(lineIndex * 3 + index, 0.1)}>{word}</span>
                  {index < 2 && "\u00a0"}
                </span>
              ))}
            </span>
          ))}
        </h2>
        <Link href="https://github.com/khuepm/lumibase" target="_blank" rel="noopener noreferrer" className={styles.cta}>
          <span>Start building</span>
          <span className={styles.statusDot} aria-hidden="true" />
        </Link>
        <p className={styles.heroNote}>Open source. Yours to build on.</p>
      </div>

      <div className={styles.connections}>
        <div className={styles.connectionHeading}>
          <a className={styles.contact} href="mailto:contact@lumibase.dev">
            Stay in touch <ArrowUpRight size={20} aria-hidden="true" />
          </a>
          <p>Think. Build. Repeat.</p>
        </div>
        <div className={styles.navigationRow}>
          <div className={styles.socials}>
            <a href="https://github.com/khuepm/lumibase" target="_blank" rel="noopener noreferrer" aria-label="LumiBase on GitHub">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <path d="M12 .75a11.25 11.25 0 0 0-3.558 21.923c.563.104.77-.244.77-.543 0-.267-.01-.974-.016-1.912-3.13.68-3.79-1.508-3.79-1.508-.512-1.3-1.25-1.647-1.25-1.647-1.023-.7.077-.686.077-.686 1.13.08 1.725 1.16 1.725 1.16 1.006 1.725 2.64 1.226 3.283.938.102-.73.394-1.226.716-1.508-2.5-.284-5.13-1.25-5.13-5.565 0-1.23.44-2.235 1.16-3.023-.116-.285-.502-1.43.11-2.98 0 0 .945-.303 3.094 1.154a10.78 10.78 0 0 1 5.625 0c2.147-1.457 3.09-1.154 3.09-1.154.614 1.55.228 2.695.113 2.98.722.788 1.157 1.793 1.157 3.023 0 4.326-2.634 5.277-5.145 5.557.405.35.767 1.043.767 2.1 0 1.515-.014 2.738-.014 3.11 0 .302.202.653.774.543A11.252 11.252 0 0 0 12 .75Z" />
              </svg>
            </a>
            <a href="https://twitter.com/khuephamminh" target="_blank" rel="noopener noreferrer" aria-label="Follow LumiBase on X">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
                <path d="M4 4l11.733 16H20L8.267 4H4Zm0 16 6.768-6.768m2.46-2.46L20 4" />
              </svg>
            </a>
            <a href="https://github.com/khuepm/lumibase/discussions" target="_blank" rel="noopener noreferrer" aria-label="Join the LumiBase community">
              <MessageCircle size={20} aria-hidden="true" />
            </a>
          </div>
          <nav className={styles.productLinks} aria-label="Footer product navigation">
            {productLinks.map((link) => <Link key={link.href} href={link.href}>{link.label}</Link>)}
            <a href="https://docs.lumibase.dev" target="_blank" rel="noopener noreferrer">Docs</a>
          </nav>
          <p className={styles.copyright}>© {new Date().getFullYear()} LumiBase</p>
        </div>
        <div className={styles.detailsRow}>
          <a href="https://docs.lumibase.dev/en/docs/ai-native-vision" target="_blank" rel="noopener noreferrer" className={styles.vision}>
            The Content Operating System <ArrowUpRight size={13} aria-hidden="true" />
          </a>
          <nav className={styles.legalLinks} aria-label="Footer legal navigation">
            {legalLinks.map((link) => <Link key={link.href} href={link.href}>{link.label}</Link>)}
          </nav>
        </div>
      </div>

      <div className={styles.wordmark} aria-label="LumiBase" role="img">
        {Array.from("LumiBase").map((letter, index) => (
          <span className={styles.letterMask} key={index} aria-hidden="true">
            <span className={styles.letter} style={delay(index, 0.09)}>{letter}</span>
          </span>
        ))}
      </div>
    </FooterMotion>
  );
}
