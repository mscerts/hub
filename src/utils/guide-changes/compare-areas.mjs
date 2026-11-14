// How the areas (domains) of an exam's study guide became the areas of the guide that replaces it, judged by
// hand for each pair in compare.mjs. The comparison pages show it as a table, as notes in "Skills at a
// glance", and it decides which domains are paired and between which domains a skill can count as moved: a
// word-overlap heuristic alone matched too loosely, and a change of this kind is rare enough to read.
//
// Each entry is `{ from: [old domain titles], to: [new domain titles], note, label?, minor? }`:
// - `from` and `to` both set: the old domains became the new ones (one to one: the domain carries over,
//   possibly renamed; several `from`: merged; several `to`: split);
// - `to` empty: the old domains are not in the new guide;
// - `from` empty: the new domains are new.
// A domain can be in several entries (a split domain whose parts went to different places). `label` is the
// bold word in front of the note; without it the page says Carried over (same title), Renamed (one to one with
// another title), Merged, Split, New or Not in <exam>, so give one when "Renamed" would mislead. `minor` marks
// an entry that only says where a small part of a domain went: it allows skills to move there and shows in
// the table, but does not pair the domains and is left out of the notes in "Skills at a glance". `pair: false`
// keeps an entry from pairing its domains when two old domains went to the same new one and only one of them
// is its real counterpart (AI-300). `note` is
// plain text, and does not repeat the label: what changed, as seen in the groups and skills of the two guides.
// Every claim in a note was checked against the skills of both guides on 2026-11-10; a title that is no longer
// in a guide is skipped on the page, and tests/scripts/guide-compare-areas.test.mjs fails, so a guide that
// Microsoft changes later gets a look here. Runbook: docs/study-guide-changes.md.

export const areasByTarget = {
  "AZ-401": [
    {
      from: ["Design and implement processes and communications"],
      to: ["Design and implement processes and communications"],
      note: "Same three groups. The weight rises from 10–15% to 15–20%. The metrics group shrinks from 7 skills to 2, and the collaboration group adds agentic development and MCP servers.",
    },
    {
      from: ["Design and implement a source control strategy"],
      to: ["Design and implement a source control strategy"],
      note: "Same two groups, now specific to Azure DevOps and GitHub. Git hooks, a repository migration from Azure DevOps to GitHub and branch policies for GitHub Copilot are added; managing large files and scaling a repository are gone.",
    },
    {
      from: ["Design and implement build and release pipelines"],
      to: ["Design and implement build and release pipelines"],
      note: "The weight drops from 50–55% to 35–40%. Pipelines, testing and maintenance are now framed around Azure DevOps pipelines and GitHub Actions, with GitHub Copilot, MCP servers and GitHub Agentic Workflows added. Packages carry over unchanged. Infrastructure as code shrinks from 5 skills to 2: desired state configuration and Azure Deployment Environments are gone.",
    },
    {
      from: ["Develop a security and compliance plan"],
      to: ["Design and implement a security and compliance plan"],
      note: "Same three groups; the weight rises from 10–15% to 15–20% and automated scanning has 3 skills instead of 6.",
    },
    {
      from: ["Implement an instrumentation strategy"],
      to: ["Implement an instrumentation strategy"],
      note: "The weight rises from 5–10% to 15–20%. A new group covers monitoring Azure workloads by using AI agents (Azure Copilot Observability Agent and Azure SRE Agent), and analyzing metrics is now done by using AI agents.",
    },
  ],

  "AZ-802": [
    {
      from: [
        "Deploy and manage Active Directory Domain Services (AD DS) in on-premises and cloud environments",
      ],
      to: ["Deploy and manage AD DS"],
      note: "Smaller: the weight drops from 30–35% to 20–25%. The hybrid identities group (7 skills: Entra Connect, Cloud Sync, Entra Domain Services and staged rollout) is not in AZ-802; the other four groups carry over.",
    },
    {
      from: ["Manage Windows Servers and workloads in a hybrid environment"],
      to: [
        "Manage Windows Server instances and workloads in a hybrid environment",
      ],
      note: "Same two groups and weight, reworded to say Windows Server instances.",
    },
    {
      from: ["Manage virtual machines and containers"],
      to: ["Manage virtual machines"],
      label: "Narrowed",
      note: "The containers group (7 skills) is gone, and so are guarded fabric and shielded VMs; Hyper-V Replica is added (it was in AZ-801). Hyper-V and Windows Server VMs on Azure remain. The weight drops from 15–20% to 10–15%.",
    },
    {
      from: [
        "Implement and manage an on-premises and hybrid networking infrastructure",
      ],
      to: [
        "Implement and manage an on-premises and hybrid networking infrastructure",
      ],
      note: "The network connectivity group (9 skills) is gone; name resolution and IP addressing remain. The weight drops from 15–20% to 10–15%.",
    },
    {
      from: ["Manage storage and file services"],
      to: ["Manage storage and file services"],
      note: "Same three groups and the same weight. Storage Spaces Direct, BitLocker and encrypted volumes are added (they were in AZ-801), and Azure Files adds migrating from file shares.",
    },
    {
      from: ["Secure Windows Server on-premises and hybrid infrastructures"],
      to: ["Secure Windows Server infrastructure"],
      label: "Narrowed",
      note: "Five groups become two and the weight drops from 25–30% to 10–15%. Windows Firewall and connection security rules and Defender for Servers are kept as skills of the operating system group. Sentinel ingestion, domain isolation, network security groups, Azure Disk Encryption, Defender for Identity, authentication policy silos and NTLM auditing are gone.",
    },
    {
      from: ["Secure Windows Server on-premises and hybrid infrastructures"],
      to: ["Manage storage and file services"],
      minor: true,
      label: "Part moved",
      note: "BitLocker and recovering encrypted volumes move to the storage domain.",
    },
    {
      from: ["Monitor and troubleshoot Windows Server environments"],
      to: ["Monitor and troubleshoot Windows Server environments"],
      note: "Same three groups and the same weight.",
    },
    {
      from: ["Implement and manage Windows Server high availability"],
      to: ["Manage storage and file services"],
      minor: true,
      label: "Mostly dropped",
      note: "Failover clustering and cluster management are gone. Only Storage Spaces Direct remains, as a skill of the storage domain.",
    },
    {
      from: ["Implement disaster recovery"],
      to: ["Manage virtual machines"],
      minor: true,
      label: "Mostly dropped",
      note: "Backup and recovery and Azure Site Recovery are gone. Only Hyper-V replicas remain, as the Hyper-V Replica skill.",
    },
    {
      from: ["Migrate servers and workloads"],
      to: [],
      note: "Storage Migration Service, Azure Migrate, migrating from earlier Windows Server versions, IIS workloads and Active Directory forests. With high availability and disaster recovery, these three domains were 45–60% of AZ-801.",
    },
  ],

  "AB-330": [
    {
      from: ["Implement product information management"],
      to: ["Implement the design to retire process"],
      label: "Reorganized",
      note: "Product setup becomes the product lifecycle: develop a product strategy, introduce products and manage active products. Pricing, trade agreements and costing now sit in these groups.",
    },
    {
      from: [
        "Implement inventory and asset management",
        "Implement warehouse management and transportation management",
      ],
      to: ["Implement the inventory to deliver process"],
      note: "Inventory, quality and warehouse operations become one process domain, with inbound and outbound goods. Asset management and most of transportation management have no counterpart in AB-330.",
    },
    {
      from: ["Implement and manage supply chain processes"],
      to: [
        "Implement the source to pay process",
        "Implement the order to cash process",
      ],
      note: "By process: procurement and sourcing go to source to pay, sales features to order to cash. Landed cost has no counterpart in AB-330.",
    },
    {
      from: ["Implement and manage supply chain processes"],
      to: ["Implement the inventory to deliver process"],
      minor: true,
      label: "Part moved",
      note: "Consignment inventory moves to inventory to deliver.",
    },
    {
      from: ["Implement master planning"],
      to: ["Implement the forecast to plan process"],
      note: "The master planning skills carry over almost unchanged under the new process name, at 1–5% instead of 10–15%.",
    },
    {
      from: [],
      to: ["Implement the plan to produce process"],
      note: "Production strategies, planning production and running production operations, including production costing (1–5%).",
    },
  ],

  "AB-650": [
    {
      from: ["Deploy and manage a Microsoft 365 tenant"],
      to: [
        "Configure and manage Microsoft 365 tenants and workloads",
        "Govern and secure Microsoft 365 tenants and workloads",
      ],
      note: "Tenant settings, licenses and service health stay in the Configure domain, which adds workloads (mailboxes, Teams, SharePoint). Managing users, groups, roles and administrative units moves under Govern and secure. Creating a tenant, software updates and adoption and usage reports are gone.",
    },
    {
      from: [
        "Implement and manage Microsoft Entra identity and access",
        "Manage security and threats by using Microsoft Defender XDR",
        "Manage compliance by using Microsoft Purview",
      ],
      to: ["Govern and secure Microsoft 365 tenants and workloads"],
      note: "Three technical domains combined into one, at a higher level. Entra: authentication methods, password protection, self-service password reset and Conditional Access carry over, directory synchronization does not. Defender: only Defender for Office 365 remains (alerts, threat policies, attack simulations); Defender for Endpoint, Defender for Cloud Apps and the XDR reports are gone. Purview: data loss prevention, information protection and retention are now about identifying requirements rather than implementing them.",
    },
    {
      from: [],
      to: ["Manage and secure AI services in Microsoft 365"],
      note: "Copilot, agents and Agent 365, and monitoring AI services (35–40% of the exam).",
    },
  ],

  "AI-103": [
    {
      from: ["Plan and manage an Azure AI solution"],
      to: ["Plan and manage an Azure AI solution"],
      note: "Four groups again, now about generative AI and agents. The weight rises from 20–25% to 25–30%.",
    },
    {
      from: [
        "Implement generative AI solutions",
        "Implement an agentic solution",
      ],
      to: ["Implement generative AI and agentic solutions"],
      note: "Building generative applications and building agents are one domain, and its weight rises to 30–35% (from 15–20% and 5–10%).",
    },
    {
      from: ["Implement computer vision solutions"],
      to: ["Implement computer vision solutions"],
      label: "Same name, new content",
      note: "Image and video generation and multimodal understanding replace image analysis and custom vision models. A group on responsible AI for multimodal content is new.",
    },
    {
      from: ["Implement natural language processing solutions"],
      to: ["Implement text analysis solutions"],
      label: "Narrowed",
      note: "Text analysis and speech remain; custom language models, question answering and custom translation are gone. The weight drops from 15–20% to 10–15%.",
    },
    {
      from: ["Implement knowledge mining and information extraction solutions"],
      to: ["Implement information extraction solutions"],
      label: "Narrowed",
      note: "Azure AI Search is now about building retrieval and grounding pipelines, and document extraction remains. The weight drops from 15–20% to 10–15%.",
    },
  ],

  "AI-901": [
    {
      from: ["Describe Artificial Intelligence workloads and considerations"],
      to: ["Identify AI concepts and capabilities"],
      label: "Expanded",
      note: "Responsible AI and AI workloads carry over. A new group covers how generative AI models work, choosing a model and its deployment configuration. The weight rises from 15–20% to 40–45%.",
    },
    {
      from: ["Describe fundamental principles of machine learning on Azure"],
      to: [],
      note: "Machine learning techniques, core concepts and Azure Machine Learning.",
    },
    {
      from: [
        "Describe features of computer vision workloads on Azure",
        "Describe features of Natural Language Processing (NLP) workloads on Azure",
        "Describe features of generative AI workloads on Azure",
      ],
      to: ["Implement AI solutions by using Microsoft Foundry"],
      note: "Three describe-the-workload domains become one implement-it domain: generative AI apps and agents, text and speech, computer vision and image generation, and information extraction, all by using Foundry.",
    },
  ],

  "AI-300": [
    {
      from: ["Design and prepare a machine learning solution"],
      to: ["Design and implement an MLOps infrastructure"],
      label: "Reshaped",
      note: "Workspace resources and assets carry over, with identity and access management and components added. Designing a machine learning solution is gone. Infrastructure as code, GitHub integration and network restrictions are new.",
    },
    {
      from: ["Explore data, and run experiments"],
      to: ["Implement machine learning model lifecycle and operations"],
      pair: false,
      label: "Fewer, broader skills",
      note: "Automated machine learning, notebooks and hyperparameter tuning (15 skills) each become a single skill of the training orchestration group (a group of 8).",
    },
    {
      from: ["Train and deploy models"],
      to: ["Implement machine learning model lifecycle and operations"],
      label: "Extended",
      note: "Training, model management and deployment carry over, with production monitoring, distributed training and progressive rollout added.",
    },
    {
      from: ["Optimize language models for AI applications"],
      to: [
        "Design and implement a GenAIOps infrastructure",
        "Optimize generative AI systems and model performance",
      ],
      note: "Selecting models and prompt versioning move to the GenAIOps infrastructure domain; retrieval-augmented generation and fine-tuning go to the optimization domain.",
    },
    {
      from: [],
      to: ["Implement generative AI quality assurance and observability"],
      note: "Evaluating and observing generative AI applications and agents.",
    },
  ],

  "AI-200": [
    {
      from: ["Develop Azure compute solutions"],
      to: [
        "Develop containerized solutions on Azure",
        "Connect to and consume Azure services",
      ],
      note: "Containers go to the containerized solutions domain, Azure Functions to the connect domain. App Service Web Apps are mostly gone: only deploying containers to App Service remains.",
    },
    {
      from: ["Develop for Azure storage"],
      to: ["Develop AI solutions by using Azure data management services"],
      label: "Reshaped",
      note: "Cosmos DB carries over as a data service for AI solutions (queries, change feed, with vector search added), with PostgreSQL and Redis added; Blob Storage is gone.",
    },
    {
      from: ["Connect to and consume Azure services and third-party services"],
      to: ["Connect to and consume Azure services"],
      note: "Service Bus and Event Grid remain; API Management, Event Hubs and Queue Storage are gone.",
    },
    {
      from: [
        "Implement Azure security",
        "Monitor, troubleshoot, and optimize Azure solutions",
      ],
      to: ["Secure, monitor, troubleshoot Azure solutions"],
      note: "Securing and monitoring are one domain, at 20–25% instead of 15–20% and 5–10%. Key Vault and App Configuration remain; user authentication (Microsoft identity platform, Entra ID, shared access signatures, Microsoft Graph) and managed identities are gone. Monitoring moves from Application Insights to OpenTelemetry and KQL.",
    },
  ],

  "SC-500": [
    {
      from: ["Secure identity and access"],
      to: ["Manage identity, access, and governance"],
      label: "Reshaped",
      note: "Privileged Identity Management, Conditional Access, MFA, app registrations and managed identities carry over. Azure role assignments move to the governance group, and Key Vault and cloud governance policies come in from the old Defender and Sentinel domain.",
    },
    {
      from: [
        "Secure Azure using Microsoft Defender for Cloud and Microsoft Sentinel",
      ],
      to: [
        "Manage and monitor security posture",
        "Manage identity, access, and governance",
      ],
      note: "Posture management and Sentinel go to the posture domain (which adds Security Copilot); Azure Policy, Key Vault and backup protection go to the identity and governance domain. Defender for Cloud alerts and workflow automation, and DevOps security, are gone.",
    },
    {
      from: [
        "Secure Azure using Microsoft Defender for Cloud and Microsoft Sentinel",
      ],
      to: ["Secure compute", "Secure storage, databases, and networking"],
      minor: true,
      label: "Part moved",
      note: "The Defender plans for Servers, Containers, Storage and Databases move into the security skills of the services they protect.",
    },
    {
      from: ["Secure networking", "Secure compute, storage, and databases"],
      to: ["Secure storage, databases, and networking"],
      note: "Networking security is combined with the storage and database parts of the old compute, storage and databases domain. Azure Firewall and private access remain. Application Gateway, Front Door, TLS and DDoS Protection have no skill of their own any more, and Web Application Firewall moves to the compute domain.",
    },
    {
      from: ["Secure compute, storage, and databases"],
      to: ["Secure compute"],
      label: "Split off",
      note: "The compute part of that domain becomes its own domain: virtual machines, containers, App Service and Functions, with security for AI added.",
    },
  ],

  "AB-210": [
    {
      from: ["Implement Dynamics 365 Sales"],
      to: [
        "Configure Dynamics 365 Sales core features for AI",
        "Optimize AI-driven sales",
      ],
      note: "Core configuration and the product catalog go to the core features domain; goals, forecasting, Sales Insights, the Sales accelerator and Copilot go to the AI-driven sales domain.",
    },
    {
      from: ["Implement Dynamics 365 Sales"],
      to: [
        "Qualify and prioritize leads by using AI",
        "Develop deals by using intelligent opportunity research",
        "Extend and enhance Sales",
      ],
      minor: true,
      label: "Part moved",
      note: "Predictive scoring and the lead experience go to the leads domain, the opportunity pipeline to the deals domain, and the Sales mobile app to Extend and enhance Sales.",
    },
    {
      from: ["Extend and enhance Dynamics 365 Sales capabilities"],
      to: ["Extend and enhance Sales"],
      note: "Teams calling remains. Document management, Teams collaboration and the Outlook app are gone; the Sales mobile app, an SMS channel and expanding the footprint by using Power Platform are added.",
    },
    {
      from: ["Configure and customize Dataverse and model-driven apps"],
      to: ["Configure Dynamics 365 Sales core features for AI"],
      minor: true,
      label: "Mostly dropped",
      note: "Only business process flows and the timeline control remain, as skills of the Configure Sales group. Dataverse table components, business logic, user experience customization and security are gone.",
    },
    {
      from: ["Demonstrate Dynamics 365 Customer Insights capabilities"],
      to: [],
      note: "Customer Insights journeys and events.",
    },
    {
      from: [],
      to: [
        "Qualify and prioritize leads by using AI",
        "Develop deals by using intelligent opportunity research",
      ],
      note: "Two new domains built around AI agents (Sales Qualification, Sales Close, Sales Research and Sales Opportunity), 40–50% of the exam together.",
    },
  ],

  "AB-410": [
    {
      from: ["Configure Microsoft Dataverse"],
      to: ["Create a foundation for intelligent applications"],
      label: "Reshaped",
      note: "Data modeling carries over, with prompt columns, row summaries, views and forms added and designing solutions by using AI-enabled tools. Dataverse search, auditing, import and export, duplicate detection and bulk deletion are gone, and security shrinks to one skill.",
    },
    {
      from: ["Create apps by using Microsoft Power Apps"],
      to: ["Create intelligent applications"],
      label: "Reshaped",
      note: "Model-driven apps carry over, and canvas apps go from described to created. Power Pages is gone.",
    },
    {
      from: ["Create and manage logic and process automation"],
      to: ["Build business application logic and automation"],
      label: "Expanded",
      note: "Cloud flows, business process flows and business logic carry over; classic Dataverse workflows and low-code plug-ins are gone. Prompts and models in AI Hub are new, and the weight rises from 25–30% to 40–45%.",
    },
    {
      from: ["Manage environments"],
      to: ["Create a foundation for intelligent applications"],
      minor: true,
      label: "Mostly dropped",
      note: "Environment types and a solution and ALM strategy now appear as skills in the design group of the foundation domain. App checker and solution checker, managing solutions, and interoperability with other services are gone.",
    },
  ],
};
