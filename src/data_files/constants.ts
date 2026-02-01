import ogImageSrc from "@images/social.png";



export const SITE = {
  title: "Microsoft Certification Hub",
  tagline: "Your Microsoft Certification Knowledge Hub",
  description: "MSFTHub is a community-driven knowledge hub for Microsoft Certifications, providing resources, guides, and a supportive environment for learners.",
  description_short: "MSFTHub is a community-driven knowledge hub for Microsoft Certifications, providing resources, guides, and a supportive environment for learners.",
  url: "https://msfthub.com",
};

export const SEO = {
  title: SITE.title,
  description: SITE.description,
  structuredData: {
    "@context": "https://schema.org",
    "@type": "WebPage",
    inLanguage: "en-US",
    "@id": SITE.url,
    url: SITE.url,
    name: SITE.title,
    description: SITE.description,
    isPartOf: {
      "@type": "WebSite",
      url: SITE.url,
      name: SITE.title,
      description: SITE.description,
    },
  },
};

export const OG = {
  locale: "en_US",
  type: "website",
  url: SITE.url,
  title: `${SITE.title}`,
  description: "MSFTHub is a community-driven knowledge hub for Microsoft Certifications, providing resources, guides, and a supportive environment for learners.",
  image: ogImageSrc,
};