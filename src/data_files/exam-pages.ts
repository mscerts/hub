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
      { label: "Tests", links: [] },
      {
        label: "Paid",
        links: [
          {
            title: "John Christopher's Course on Udemy",
            href: "https://trk.udemy.com/rEJP93",
            target: "_blank",
          },
        ],
      },
      { label: "Misc", links: [] },
    ],
    measureUpReleased: false,
  },
  "AI-103": {
    examCode: "AI-103",
    getStartedLinks: [
      {
        title: "Exam AI-103: Developing AI Apps and Agents on Azure",
        href: "https://learn.microsoft.com/credentials/certifications/azure-ai-apps-and-agents-developer-associate?WT.mc_id=studentamb_165290",
        target: "_blank",
        description:
          "As a candidate for this Microsoft Certification, you’re an Azure AI engineer who builds, manages, and deploys agents and AI solutions that take advantage of Microsoft Foundry.",
      },
      {
        title: "AI-103 Study Guide",
        href: "https://learn.microsoft.com/credentials/certifications/resources/study-guides/ai-103?WT.mc_id=studentamb_165290",
        target: "_blank",
        description:
          "Study guide contains topics and information you need to know to successfully prepare for the exam.",
      },
      {
        title: "Exam Labs",
        href: "/labs/azure/ai-103/",
        target: "_blank",
        description:
          "Collection of all lab exercises that Microsoft offers. Includes Labs for Instructor Lead Trainings.",
      },
    ],
    tabs: [
      {
        label: "Text",
        links: [
          {
            title: "Microsoft Learn",
            href: "https://learn.microsoft.com/training/courses/ai-103t00/?WT.mc_id=studentamb_165290#course-syllabus",
            target: "_blank",
            description:
              "This course is intended for software developers wanting to build AI infused applications that leverage Microsoft Foundry. Topics in this course include developing generative AI apps, building AI agents, and solutions that implement knowledge connections or tools in your agentic applications.",
          },
        ],
      },
      { label: "Videos", links: [] },
      { label: "Tests", links: [] },
      { label: "Paid", links: [] },
      {
        label: "Misc",
        links: [
          {
            title: "Absolute Beginner Guide to Python, John Savill",
            href: "https://www.youtube.com/watch?v=VE1HAjJB7cs",
            target: "_blank",
          },
        ],
      },
    ],
    measureUpReleased: false,
  },
};
