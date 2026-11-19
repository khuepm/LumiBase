import styles from "./StoryFaq.module.css";

export const faqs = [
  {
    question: "What is a Content Operating System?",
    answer:
      "A traditional CMS is a tool humans use to manipulate content one operation at a time. A Content Operating System inverts that: you declare the desired state of your content (its SLOs), and a control loop of governed AI agents continuously reconciles content toward that state — with full provenance and human veto. LumiBase is that runtime.",
  },
  {
    question: "How is this different from an AI plugin bolted onto a CMS?",
    answer:
      "Autonomy in LumiBase is earned, not granted. Every (site, agent, capability) sits on a trust ladder from L0 (shadow) to L4 (autopilot). Agents are promoted by passing evaluations and auto-demoted on incidents. Every action is gated by a versioned tenant constitution and recorded with provenance.",
  },
  {
    question: "Do humans lose control?",
    answer:
      "No. Humans set intent, taste, and policy, and hold the veto. The L3 veto window stages dangerous changes and commits them only if no human objects within a time budget. A four-scope kill switch can halt agents instantly. Nothing publishes that fails the constitution.",
  },
  {
    question: "Is it open source?",
    answer:
      "Yes. The core LumiBase is free forever under the Apache 2.0 license. It runs edge-native on Cloudflare Workers and can also be self-hosted with Docker via a shared runtime abstraction.",
  },
] as const;

export const faqPageJsonLd = {
  "@context": "https://schema.org",
  "@type": "FAQPage",
  mainEntity: faqs.map((faq) => ({
    "@type": "Question",
    name: faq.question,
    acceptedAnswer: { "@type": "Answer", text: faq.answer },
  })),
};

/** The questions after the story closes — plain HTML, readable without the scene. */
export default function StoryFaq() {
  return (
    <section id="faq" className={styles.faq} aria-labelledby="faq-title">
      <div className={styles.inner}>
        <p className={styles.eyebrow}>Afterword · Questions, answered</p>
        <h2 id="faq-title" className={styles.heading}>
          Before you <em>turn the page.</em>
        </h2>
        <dl className={styles.list}>
          {faqs.map((faq) => (
            <div key={faq.question} className={styles.item}>
              <dt>{faq.question}</dt>
              <dd>{faq.answer}</dd>
            </div>
          ))}
        </dl>
      </div>
    </section>
  );
}
