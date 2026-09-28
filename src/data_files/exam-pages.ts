export interface ExamLink {
  title: string;
  href: string;
  description?: string;
  target?: "_blank";
}

export interface ExamTab {
  label: "Text" | "Videos" | "Tests" | "Paid" | "Misc";
  links: ExamLink[];
}

export interface ExamPageData {
  examCode: string;
  getStartedLinks: ExamLink[];
  tabs: ExamTab[];
  measureUpReleased: boolean;
}

export const examPages: Record<string, ExamPageData> = {
  "AI-901": {
    examCode: "AI-901",
    getStartedLinks: [
      {
        title: "Exam AI-901: Microsoft Azure AI Fundamentals",
        href: "https://learn.microsoft.com/credentials/certifications/exams/ai-901/?WT.mc_id=studentamb_165290",
        target: "_blank",
        description:
          "This certification is intended for individuals who want to start working with AI solutions built on Azure. It is suitable for learners from technical backgrounds, including aspiring junior developers who are starting to incorporate AI capabilities into applications.",
      },
      {
        title: "AI-901 Study Guide",
        href: "https://learn.microsoft.com/credentials/certifications/resources/study-guides/ai-901?WT.mc_id=studentamb_165290",
        target: "_blank",
        description:
          "Study guide contains topics and information you need to know to successfully prepare for the exam.",
      },
      {
        title: "Exam Labs",
        href: "/labs/azure/ai-901/",
        target: "_blank",
        description:
          "Collection of all lab exercises that Microsoft offers. Includes Labs for Microsoft Learn.",
      },
      {
        title: "How to Prepare for Fundamentals Exams",
        href: "/prepare/fundamentals/",
        description:
          "Guidance on study time, resources, and readiness for Microsoft Fundamentals exams.",
      },
    ],
    tabs: [
      {
        label: "Text",
        links: [
          {
            title: "Microsoft Learn",
            href: "https://learn.microsoft.com/training/courses/ai-901t00/?WT.mc_id=studentamb_165290#course-syllabus",
            target: "_blank",
            description:
              "This course introduces fundamental concepts related to artificial intelligence (AI), and the services in Microsoft Azure that can be used to create AI solutions.",
          },
        ],
      },
      {
        label: "Videos",
        links: [
          {
            title:
              "Microsoft Virtual Training Day: Develop generative AI apps with Azure AI Foundry",
            href: "https://www.microsoft.com/events/category/microsoft-virtual-training-days?filters=primary-language%3Aenglish%2Cproduct%3Aazure&scenario=mvtd&q=Microsoft+Virtual+Training+Day%3A+Develop+generative+AI+apps+with+Azure+AI+Foundry",
            target: "_blank",
          },
        ],
      },
      { label: "Tests", links: [
        {
          title: "Microsoft Learn Practice Assessment (AI Skills Navigator)",
          href: "https://aiskillsnavigator.microsoft.com/credentials/cert-83587e0a0754cfee561ade3e27d9fa1cdaf15ae03be52d2413b2b858d1b4eda4",
          target: "_blank",
          description:
            "Mini test that shows examples of how exam questions are structured. It is not equivalent to the real exams in format/difficulty. It is easier than real exams.",
        },
        {
          title: "Whizlab Practice Tests",
          href: "https://www.whizlabs.com/ai-901-microsoft-azure-ai-fundamentals/",
          target: "_blank",
        },
        {
          title: "CertiAce Practice Tests",
          href: "https://certiace.com/practice/AI-901",
          target: "_blank",
        },
      ] },
      {
        label: "Paid",
        links: [
          {
            title: "John Christopher's Course on Udemy",
            href: "https://trk.udemy.com/rEJP93",
            target: "_blank",
          },
          {
            title: "Pluralsight Course",
            href: "https://www.pluralsight.com/paths/ai-901-microsoft-azure-ai-fundamentals",
            target: "_blank",
          },
        ],
      },
      { label: "Misc", links: [] },
    ],
    measureUpReleased: false,
  },
};
