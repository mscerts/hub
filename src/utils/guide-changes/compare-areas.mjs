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
// Every claim in a note was checked against the skills of both guides on 2026-11-10, and again against the
// hand review of every skill in compare-tasks.mjs on 2026-11-16: a note must agree with that review (where
// each skill went, what was merged, removed or added), so update both together. A title that is no longer
// in a guide is skipped on the page, and tests/scripts/guide-compare-areas.test.mjs fails, so a guide that
// Microsoft changes later gets a look here. Runbook: docs/study-guide-changes.md.

export const areasByTarget = {
  "AZ-401": [
    {
      from: ["Design and implement processes and communications"],
      to: ["Design and implement processes and communications"],
      note: "Same three groups. The weight rises from 10–15% to 15–20%. The six metrics and queries skills (project planning, development, testing, security, delivery and operations) become two success metrics skills, and the dashboard skill moves to monitoring. The collaboration group merges three documentation skills into one, adds agentic development and MCP servers, and drops the Microsoft Teams integration.",
    },
    {
      from: ["Design and implement a source control strategy"],
      to: ["Design and implement a source control strategy"],
      note: "Same two groups, now specific to Azure DevOps and GitHub. Git hooks, a repository migration from Azure DevOps to GitHub and branch policies for GitHub Copilot are added; managing large files and scaling a repository are gone, and recovering and removing data become one skill.",
    },
    {
      from: ["Design and implement build and release pipelines"],
      to: ["Design and implement build and release pipelines"],
      note: "The weight drops from 50–55% to 35–40%. Pipelines, testing and maintenance are now framed around Azure DevOps pipelines and GitHub Actions, with GitHub Copilot, MCP servers and GitHub Agentic Workflows added. Packages keep their four skills. Complex pipeline scenarios, feature flags with Azure App Configuration Feature Manager (feature flags stay part of the deployment strategy) and migrating a classic pipeline to YAML are gone. Infrastructure as code shrinks from 5 skills to 2: desired state configuration and Azure Deployment Environments are gone.",
    },
    {
      from: ["Develop a security and compliance plan"],
      to: ["Design and implement a security and compliance plan"],
      note: "Same three groups; the weight rises from 10–15% to 15–20%. Automated scanning has 3 skills instead of 6: the GitHub Advanced Security and Defender for Cloud skills are combined in pairs and container scanning is gone.",
    },
    {
      from: ["Implement an instrumentation strategy"],
      to: ["Implement an instrumentation strategy"],
      note: "The weight rises from 5–10% to 15–20%. A new group covers monitoring Azure workloads by using AI agents (Azure Copilot Observability Agent and Azure SRE Agent), and analyzing metrics is now done by using AI agents, with GitHub Copilot agent logs added. Configuring telemetry collection (Application Insights, VM, container, storage and network insights) is gone.",
    },
  ],

  "AZ-802": [
    {
      from: [
        "Deploy and manage Active Directory Domain Services (AD DS) in on-premises and cloud environments",
      ],
      to: ["Deploy and manage AD DS"],
      note: "Smaller: the weight drops from 30–35% to 20–25%. The hybrid identities group (Entra Connect Sync, Cloud Sync, Connect Health, Entra Domain Services and staged rollout) is not in AZ-802; only managing authentication carries over, into the Secure AD DS group. Joining servers to AD DS and Microsoft Entra and Group Policy in Entra Domain Services are gone too. The other four groups carry over, and the two service account skills become one.",
    },
    {
      from: ["Manage Windows Servers and workloads in a hybrid environment"],
      to: [
        "Manage Windows Server instances and workloads in a hybrid environment",
      ],
      note: "Same two groups and weight, reworded to say Windows Server instances. PowerShell remoting and Just Enough Administration become one skill, and so do the two Azure Automation skills.",
    },
    {
      from: ["Manage virtual machines and containers"],
      to: ["Manage virtual machines"],
      label: "Narrowed",
      note: "The containers group (7 skills) is gone, and so are guarded fabric and shielded VMs, moving secure VMs between Hyper-V hosts, and VM resource groups, CPU groups and hypervisor scheduling. The four Hyper-V replica skills of AZ-801 become one Hyper-V Replica skill. Hyper-V and Windows Server VMs on Azure remain. The weight drops from 15–20% to 10–15%.",
    },
    {
      from: [
        "Implement and manage an on-premises and hybrid networking infrastructure",
      ],
      to: [
        "Implement and manage an on-premises and hybrid networking infrastructure",
      ],
      note: "The network connectivity group (9 skills) is gone, and so is IP Address Management (IPAM); name resolution and IP addressing remain. The weight drops from 15–20% to 10–15%.",
    },
    {
      from: ["Manage storage and file services"],
      to: ["Manage storage and file services"],
      note: "Same three groups and the same weight. Storage Spaces Direct (3 skills of AZ-801 become 1), BitLocker and recovering encrypted volumes are added from AZ-801, and Azure Files adds migrating from file shares (also from AZ-801). BranchCache is gone.",
    },
    {
      from: ["Secure Windows Server on-premises and hybrid infrastructures"],
      to: ["Secure Windows Server infrastructure"],
      label: "Narrowed",
      note: "Five groups become two and the weight drops from 25–30% to 10–15%. Windows Firewall with connection security rules, and Defender for Cloud with Defender for Servers, each become one skill of the operating system group. Auditing and disabling NTLM becomes part of a skill on authentication protocols and methods. Sentinel ingestion, domain isolation, network security groups, Azure Disk Encryption and its keys, Defender for Identity and authentication policy silos are gone.",
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
      note: "Same three groups and the same weight. Troubleshooting deployment and booting failures is gone, and troubleshooting secure channel and computer account trust issues becomes a skill of its own.",
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
      to: ["Manage storage and file services"],
      minor: true,
      label: "Mostly dropped",
      note: "Storage Migration Service, Azure Migrate, migrating from earlier Windows Server versions, IIS workloads and Active Directory forests are gone. Only migrating to Azure file shares remains, as a skill of the Azure Files group. With high availability and disaster recovery, these three domains were 45–60% of AZ-801.",
    },
  ],

  "AB-330": [
    {
      from: ["Implement product information management"],
      to: ["Implement the design to retire process"],
      label: "Reorganized",
      note: "Product setup becomes the product lifecycle: develop a product strategy, introduce products and manage active products. Pricing, trade agreements and costing now sit in these groups, and formulas are added. Product templates, bar codes, unit conversions, default order settings and price groups are gone.",
    },
    {
      from: [
        "Implement inventory and asset management",
        "Implement warehouse management and transportation management",
      ],
      to: ["Implement the inventory to deliver process"],
      note: "Inventory, quality and warehouse operations become one process domain, with inbound and outbound goods. Asset management, setting up the Warehouse Management mobile app and most of transportation management have no counterpart in AB-330, and neither do batch disposition codes, inventory reports, packing dimensions and containerization.",
    },
    {
      from: ["Implement and manage supply chain processes"],
      to: [
        "Implement the source to pay process",
        "Implement the order to cash process",
      ],
      note: "By process: procurement and sourcing go to source to pay, sales features to order to cash. Landed cost, customer rebates and product bundles have no counterpart in AB-330.",
    },
    {
      from: ["Implement and manage supply chain processes"],
      to: ["Implement the inventory to deliver process"],
      minor: true,
      label: "Part moved",
      note: "Consignment inventory and registering product receipts move to inventory to deliver.",
    },
    {
      from: ["Implement master planning"],
      to: ["Implement the forecast to plan process"],
      note: "The master planning skills carry over almost unchanged under the new process name, at 1–5% instead of 10–15%. Forecast models, supply chain calendars and intercompany master planning are added; period templates and the Supply schedule page are gone.",
    },
    {
      from: ["Implement master planning"],
      to: ["Implement the inventory to deliver process"],
      minor: true,
      label: "Part moved",
      note: "Safety stock journals move to inventory to deliver.",
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
      note: "Tenant settings, licenses and service health stay in the Configure domain, with branding and licenses for AI services added, and the domain adds workloads (mailboxes, Teams, SharePoint). Managing users, groups, roles and administrative units moves under Govern and secure. Creating a tenant and software updates are gone.",
    },
    {
      from: ["Deploy and manage a Microsoft 365 tenant"],
      to: ["Manage and secure AI services in Microsoft 365"],
      minor: true,
      label: "Part moved",
      note: "Monitoring Microsoft 365 adoption and usage becomes two skills on Copilot and AI usage and adoption reports.",
    },
    {
      from: [
        "Implement and manage Microsoft Entra identity and access",
        "Manage security and threats by using Microsoft Defender XDR",
        "Manage compliance by using Microsoft Purview",
      ],
      to: ["Govern and secure Microsoft 365 tenants and workloads"],
      note: "Three technical domains combined into one, at a higher level. Entra: authentication methods, password protection, self-service password reset and Conditional Access carry over, directory synchronization does not. Defender: only Defender for Office 365 remains (alerts, threat policies, attack simulations); Defender for Endpoint, Defender for Cloud Apps and the XDR reports are gone. Purview: data loss prevention, information protection and retention are now about identifying requirements rather than implementing them, label usage reports are gone, and monitoring AI activity with Data Security Posture Management is added.",
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
      note: "Four groups again, now about generative AI and agents. The weight rises from 20–25% to 25–30%. Setting up resources for generative AI and agents moves in from the other domains, and planning for Responsible AI principles and container deployment are gone.",
    },
    {
      from: [
        "Implement generative AI solutions",
        "Implement an agentic solution",
      ],
      to: ["Implement generative AI and agentic solutions"],
      note: "Building generative applications and building agents are one domain, and its weight rises to 30–35% (from 15–20% and 5–10%). Provisioning and deploying resources moves to Plan and manage, image generation and multimodal models to computer vision. Prompt engineering, prompt templates and generation parameters become one optimization skill; fine-tuning a model and deploying containers to local and edge devices are gone.",
    },
    {
      from: ["Implement computer vision solutions"],
      to: ["Implement computer vision solutions"],
      label: "Same name, new content",
      note: "Image and video analysis become multimodal understanding workflows, and extracting printed and handwritten text moves to information extraction. Custom vision models are gone. Image and video generation (from DALL-E image generation) and a group on responsible AI for multimodal content are new.",
    },
    {
      from: ["Implement natural language processing solutions"],
      to: ["Implement text analysis solutions"],
      label: "Narrowed",
      note: "Text analysis and speech remain; custom language models, question answering and custom translation are gone, and so are language detection, SSML and intent and keyword recognition. Customizing language model outputs and reasoning over audio are added. The weight drops from 15–20% to 10–15%.",
    },
    {
      from: ["Implement knowledge mining and information extraction solutions"],
      to: ["Implement information extraction solutions"],
      label: "Narrowed",
      note: "Azure AI Search is now about building retrieval and grounding pipelines, connected to workflows and agent tools, and document extraction remains. Knowledge Store projections, provisioning a Document Intelligence resource, and training and composing custom Document Intelligence models are gone. The weight drops from 15–20% to 10–15%.",
    },
  ],

  "AI-901": [
    {
      from: ["Describe Artificial Intelligence workloads and considerations"],
      to: ["Identify AI concepts and capabilities"],
      label: "Expanded",
      note: "Responsible AI and AI workloads carry over, and the identify-the-workload skills of the computer vision, NLP and generative AI domains join them. A group on how generative AI models work, choosing a model and its deployment configuration comes from the generative AI domain. The weight rises from 15–20% to 40–45%.",
    },
    {
      from: ["Describe fundamental principles of machine learning on Azure"],
      to: [],
      note: "Machine learning techniques, core concepts and Azure Machine Learning.",
    },
    {
      from: ["Describe features of computer vision workloads on Azure"],
      to: ["Identify AI concepts and capabilities"],
      pair: false,
      label: "Moved",
      note: "Image classification, object detection and Azure AI Vision become one skill on computer vision and image-generation models, and optical character recognition becomes part of the information extraction techniques, both in Identify AI workloads. Facial detection and analysis and the Face service are gone.",
    },
    {
      from: [
        "Describe features of Natural Language Processing (NLP) workloads on Azure",
      ],
      to: ["Identify AI concepts and capabilities"],
      pair: false,
      label: "Moved",
      note: "Key phrase extraction, entity recognition and sentiment analysis become one text analysis skill, and speech recognition and synthesis carries over, both in Identify AI workloads. Language modeling and translation are gone.",
    },
    {
      from: [
        "Describe features of Natural Language Processing (NLP) workloads on Azure",
      ],
      to: ["Implement AI solutions by using Microsoft Foundry"],
      minor: true,
      label: "Part moved",
      note: "Describing the Language and Speech services becomes building lightweight applications for text analysis and with Azure Speech in Foundry Tools.",
    },
    {
      from: ["Describe features of generative AI workloads on Azure"],
      to: ["Identify AI concepts and capabilities"],
      pair: false,
      label: "Moved",
      note: "How generative AI models work, generative AI scenarios and responsible AI carry over, and the overview of Azure AI Foundry, Azure OpenAI and the model catalog becomes choosing a model and its deployment options and configuration.",
    },
    {
      from: ["Describe features of generative AI workloads on Azure"],
      to: ["Implement AI solutions by using Microsoft Foundry"],
      minor: true,
      label: "Part moved",
      note: "Deploying a model and interacting with it in the Foundry portal comes from the same overview.",
    },
    {
      from: [],
      to: ["Implement AI solutions by using Microsoft Foundry"],
      note: "Twelve of its fifteen skills: prompts, a chat client with the Foundry SDK, single-agent solutions and their client applications, spoken and visual prompts to a multimodal model, generating images, a vision application, and extracting information from documents, images, audio and video with Content Understanding.",
    },
  ],

  "AI-300": [
    {
      from: ["Design and prepare a machine learning solution"],
      to: ["Design and implement an MLOps infrastructure"],
      label: "Reshaped",
      note: "Workspace resources and assets carry over, with identity and access management added and components moving in from training pipelines. Setting up Git integration becomes GitHub integration and Git source control in an infrastructure as code group, where deploying with Bicep and Azure CLI, provisioning with GitHub Actions and network restrictions are new. Designing a machine learning solution is gone.",
    },
    {
      from: ["Explore data, and run experiments"],
      to: ["Implement machine learning model lifecycle and operations"],
      pair: false,
      label: "Fewer, broader skills",
      note: "Automated machine learning (5 skills), notebook experimentation (3) and hyperparameter tuning (4) each become a single skill of the training orchestration group, and MLflow tracking joins its experiment tracking skill. Evaluating a model with responsible AI guidelines joins the responsible AI skill of model registration; retrieving features from a feature store is gone.",
    },
    {
      from: ["Train and deploy models"],
      to: ["Implement machine learning model lifecycle and operations"],
      label: "Extended",
      note: "Training, model management and deployment carry over in fewer skills: the six job skills become one, the four pipeline skills one, and online and batch deployment one skill to deploy and one to test. Production monitoring, distributed training, comparing jobs, model lifecycle management and progressive rollout are added.",
    },
    {
      from: ["Train and deploy models"],
      to: ["Design and implement an MLOps infrastructure"],
      minor: true,
      label: "Part moved",
      note: "Creating custom components moves to the workspace assets group.",
    },
    {
      from: ["Optimize language models for AI applications"],
      to: [
        "Design and implement a GenAIOps infrastructure",
        "Optimize generative AI systems and model performance",
      ],
      note: "Selecting, comparing and deploying language models and prompt engineering (now designing prompts, comparing variants and versioning them with Git) move to the GenAIOps infrastructure domain; retrieval-augmented generation and fine-tuning go to the optimization domain. Testing in the playground, choosing an optimization approach and prompt flow chaining are gone.",
    },
    {
      from: ["Optimize language models for AI applications"],
      to: ["Implement generative AI quality assurance and observability"],
      minor: true,
      label: "Part moved",
      note: "Tracing a flow becomes logging, tracing and debugging for production troubleshooting.",
    },
    {
      from: [],
      to: ["Implement generative AI quality assurance and observability"],
      note: "Evaluating and observing generative AI applications and agents: seven of its eight skills.",
    },
  ],

  "AI-200": [
    {
      from: ["Develop Azure compute solutions"],
      to: [
        "Develop containerized solutions on Azure",
        "Connect to and consume Azure services",
      ],
      note: "Containers go to the containerized solutions domain, Azure Functions to the connect domain. App Service Web Apps narrow to one skill on deploying containers to App Service; diagnostics, autoscaling, deployment slots and Azure Container Instances are gone. Container Registry Tasks, AKS and KEDA scaling are added.",
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
      note: "Securing and monitoring are one domain, at 20–25% instead of 15–20% and 5–10%. Key Vault and App Configuration remain; user authentication (Microsoft identity platform, Entra ID, shared access signatures, Microsoft Graph) and managed identities are gone. Monitoring moves from Application Insights to OpenTelemetry and KQL, and availability tests and alerts are gone.",
    },
  ],

  "SC-500": [
    {
      from: ["Secure identity and access"],
      to: ["Manage identity, access, and governance"],
      label: "Reshaped",
      note: "Privileged Identity Management, Conditional Access, MFA and managed identities carry over, and the five enterprise application, app registration, permission scope, consent and service principal skills become two. Azure built-in and custom roles move to the governance group, which adds resource locks, overprivileged access assignments and infrastructure as code. Key Vault and cloud governance policies come in from the old Defender and Sentinel domain.",
    },
    {
      from: [
        "Secure Azure using Microsoft Defender for Cloud and Microsoft Sentinel",
      ],
      to: [
        "Manage and monitor security posture",
        "Manage identity, access, and governance",
      ],
      note: "Posture management and Sentinel go to the posture domain, which adds Security Copilot and Sentinel workspaces, roles, content hub, syslog and CEF, custom tables, retention and Purview Audit. Azure Policy, Key Vault, backup protection and the management of compliance and custom standards go to the identity and governance domain, where Key Vault gains deployment, settings, secret scanning and Defender for Key Vault. Defender for Cloud alerts and workflow automation, DevOps security, Sentinel analytics rules and security controls for asset management are gone.",
    },
    {
      from: [
        "Secure Azure using Microsoft Defender for Cloud and Microsoft Sentinel",
      ],
      to: ["Secure compute", "Secure storage, databases, and networking"],
      minor: true,
      label: "Part moved",
      note: "Defender for Servers (with agentless scanning), Defender for Storage and Defender for Databases move into the security skills of the services they protect.",
    },
    {
      from: ["Secure networking", "Secure compute, storage, and databases"],
      to: ["Secure storage, databases, and networking"],
      note: "Networking security is combined with the storage and database parts of the old compute, storage and databases domain. NSGs, Virtual Network Manager, Virtual WAN, Azure Firewall, Network Watcher, Private Endpoints and Private Link carry over, peering, VPN gateway and VPN connectivity become one VPN skill, and Entra Private Access is added. User-defined routes, ExpressRoute encryption, Service Endpoints and DDoS Protection are gone. The four storage access skills become one, and data protection, BYOK and double encryption another; Entra authentication, dynamic masking, Transparent Data Encryption, Always Encrypted and SQL Managed Instance network security become one Azure SQL platform security skill.",
    },
    {
      from: ["Secure networking"],
      to: ["Secure compute", "Manage identity, access, and governance"],
      minor: true,
      label: "Part moved",
      note: "App Service and Functions network integration, App Service Environment network security and TLS go to the App Service and Functions skills; Application Gateway, Front Door and Web Application Firewall become one Web Application Firewall skill. Firewall settings on Azure resources also feed the Key Vault firewall skill.",
    },
    {
      from: ["Secure compute, storage, and databases"],
      to: ["Secure compute"],
      label: "Split off",
      note: "The compute part of that domain becomes its own domain. Bastion and just-in-time access become separate skills and disk encryption carries over; the three AKS skills become AKS security controls and Defender for Containers, Container Instances and Container Apps monitoring become one skill, and Container Registry and API Management carry over. Azure Arc, Defender for Servers onboarding, VM security features, Machine Configuration, Logic Apps and a whole group on security for AI are added.",
    },
  ],

  "AB-210": [
    {
      from: ["Implement Dynamics 365 Sales"],
      to: [
        "Configure Dynamics 365 Sales core features for AI",
        "Optimize AI-driven sales",
      ],
      note: "The product catalog goes to the core features domain: five catalog skills become one on products and product families, and price lists and the enhanced add-products experience become a price list skill there and an opportunity products and pricing skill in the deals domain. Goals, forecasting, Sales Insights, the Sales accelerator, work assignment, predictive scoring, Copilot and the Sales Pipeline chart go to the AI-driven sales domain, where the six Sales accelerator and sequence skills become one and assignment rules, segments and work assignment another; it adds Copilot and agents in seller workflows and a group on preparing to deploy agents. Sales order processing, automatic lead creation rules, sales territories and the assistant are gone.",
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
      note: "The lead qualification experience, status reasons and opportunity close become one lead and opportunity experience skill in the leads domain, which also gets fine-tuning of the predictive scoring model. The opportunity pipeline view and opportunity products and pricing go to the deals domain, and the Sales mobile app to Extend and enhance Sales.",
    },
    {
      from: ["Extend and enhance Dynamics 365 Sales capabilities"],
      to: ["Extend and enhance Sales"],
      note: "Teams calling carries over, and the Sales mobile app, Power Automate flows and embedded Power BI come in from the other domains; an SMS channel and embedded Power Apps components are added. Document management, Teams collaboration and the Outlook skills move to the core features domain.",
    },
    {
      from: ["Extend and enhance Dynamics 365 Sales capabilities"],
      to: ["Configure Dynamics 365 Sales core features for AI"],
      minor: true,
      label: "Part moved",
      note: "Document management, Teams collaboration, the common Outlook tasks and the Dynamics 365 App for Outlook become one skill on Microsoft 365 functionality (Teams, SharePoint, Outlook and OneDrive) in the Configure Sales group.",
    },
    {
      from: ["Configure and customize Dataverse and model-driven apps"],
      to: [
        "Configure Dynamics 365 Sales core features for AI",
        "Optimize AI-driven sales",
        "Extend and enhance Sales",
      ],
      note: "The eight security skills become one on the Sales security model, and business process flows and the timeline carry over, all in the Configure Sales group, which adds deployment prerequisites, mailboxes and data import and export. Tables, columns and relationships become a sales data model skill and model-driven app visualizations join the reporting options skill in the AI-driven sales domain; cloud flows with the Dataverse connector and embedded Power BI go to Expand the sales footprint. The Environment Settings app (email, Word and Excel templates, duplicate detection), auditing, connection roles, business rules, formula and rollup columns, form and view types, creating model-driven apps and the types of Power Apps are gone.",
    },
    {
      from: ["Demonstrate Dynamics 365 Customer Insights capabilities"],
      to: [],
      note: "Customer Insights - Journeys marketing emails, journeys, forms, text messages, segments, consent management and events.",
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
      note: "Tables, columns, relationships and table properties carry over into Build data models, with prompt columns and row summaries added, and the six security skills become one; rollup and formula columns also become a skill of business and process logic. Dataverse search, auditing, import and export, duplicate detection and bulk deletion are gone. The domain also gets a group on designing solutions by using AI-enabled tools: analyzing requirements, evaluating built-in agents and recommending extensibility options are new, and solutions and environments come from the old Manage environments domain.",
    },
    {
      from: ["Create apps by using Microsoft Power Apps"],
      to: ["Create intelligent applications"],
      label: "Reshaped",
      note: "Model-driven app forms, views and dashboards carry over, custom pages become generative pages, and composing an app and access to forms, views and apps are added. Canvas apps go from described to created, with accessibility, testing and creating a Copilot Studio agent added. Modern commanding, embedding a canvas app in a form, and Power Pages are gone.",
    },
    {
      from: ["Create apps by using Microsoft Power Apps"],
      to: ["Create a foundation for intelligent applications"],
      minor: true,
      label: "Part moved",
      note: "Model-driven app forms and views also become main forms and public views in Build data models.",
    },
    {
      from: ["Create and manage logic and process automation"],
      to: ["Build business application logic and automation"],
      label: "Expanded",
      note: "Cloud flows carry over with approvals added, the three business process flow skills become one, and business rules remain; types of flows also becomes evaluating use cases for business logic. Classic Dataverse workflows, low-code plug-ins and Power Fx functions are gone. Prompts and models in AI Hub are new, and the weight rises from 25–30% to 40–45%.",
    },
    {
      from: ["Manage environments"],
      to: ["Create a foundation for intelligent applications"],
      minor: true,
      label: "Mostly dropped",
      note: "Managing Dataverse solutions, managed and unmanaged solutions, and importing and exporting them become one skill on a solution and ALM strategy, and development environments become recommending environment types, both in the design group of the foundation domain. App checker and solution checker, and interoperability with other services (email and SharePoint integration, document management and Word templates), are gone.",
    },
  ],
};
