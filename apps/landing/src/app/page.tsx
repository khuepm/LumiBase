import { version as lumibaseVersion } from "../../package.json";
import StorybookLanding from "@/components/storybook/StorybookLanding";
import StoryFaq, { faqPageJsonLd } from "@/components/storybook/StoryFaq";

const softwareApplicationJsonLd = {
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  name: "LumiBase",
  url: "https://lumibase.dev",
  applicationCategory: "DeveloperApplication",
  operatingSystem: "Cloudflare Workers, Docker, Node.js",
  description:
    "LumiBase is a Content Operating System: an edge-native, AI-native headless CMS where governed agents operate content against declarative SLOs while humans set intent, taste, and accountability.",
  softwareVersion: lumibaseVersion,
  codeRepository: "https://github.com/khuepm/lumibase",
  license: "https://lumibase.dev/license",
  isAccessibleForFree: true,
  author: {
    "@type": "Person",
    name: "Khuepm",
    url: "https://github.com/khuepm",
  },
};

export default function Home() {
  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify(softwareApplicationJsonLd),
        }}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(faqPageJsonLd) }}
      />
      <StorybookLanding />
      <StoryFaq />
    </>
  );
}
