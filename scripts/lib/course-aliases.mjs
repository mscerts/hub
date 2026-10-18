/**
 * Abbreviations the candidate generator treats as the same thing as their long form, in a task and in a page
 * title alike ("Assign Azure roles using the Azure portal - Azure RBAC" covers "role-based access control").
 * Each entry is one concept: `words` are the abbreviations (one word each), `phrases` the long forms. A task or
 * a page that says any of them has the concept; the search matches on the concept, so "RBAC" finds "role-based
 * access control" and the other way round.
 *
 * Keep it to terms that mean one thing in Microsoft's documentation. A short word that is also a word
 * ("arm" the limb, "pr" the press release) does not belong here unless the phrase is the only reading in the
 * certification world. Adding an entry changes the rankings of every exam: run the tests, and check one exam.
 */
export const ALIASES = [
  {
    concept: "rbac",
    words: ["rbac"],
    phrases: ["role based access control"],
  },
  { concept: "vm", words: ["vm", "vms"], phrases: ["virtual machine"] },
  {
    concept: "vmss",
    words: ["vmss"],
    phrases: ["virtual machine scale set"],
  },
  { concept: "vnet", words: ["vnet", "vnets"], phrases: ["virtual network"] },
  {
    concept: "nsg",
    words: ["nsg", "nsgs"],
    phrases: ["network security group"],
  },
  {
    concept: "asg",
    words: ["asg", "asgs"],
    phrases: ["application security group"],
  },
  {
    concept: "udr",
    words: ["udr", "udrs"],
    phrases: ["user defined route"],
  },
  {
    concept: "sspr",
    words: ["sspr"],
    phrases: ["self service password reset"],
  },
  {
    concept: "mfa",
    words: ["mfa"],
    phrases: ["multi factor authentication", "multifactor authentication"],
  },
  {
    concept: "2fa",
    words: ["2fa"],
    phrases: ["two factor authentication"],
  },
  {
    concept: "pim",
    words: ["pim"],
    phrases: ["privileged identity management"],
  },
  {
    concept: "sas",
    words: ["sas"],
    phrases: ["shared access signature"],
  },
  { concept: "arm", words: ["arm"], phrases: ["azure resource manager"] },
  { concept: "aks", words: ["aks"], phrases: ["azure kubernetes service"] },
  { concept: "acr", words: ["acr"], phrases: ["azure container registry"] },
  { concept: "aci", words: ["aci"], phrases: ["azure container instances"] },
  {
    concept: "asr",
    words: ["asr"],
    phrases: ["azure site recovery"],
  },
  { concept: "ase", words: ["ase"], phrases: ["app service environment"] },
  { concept: "afd", words: ["afd"], phrases: ["azure front door"] },
  { concept: "waf", words: ["waf"], phrases: ["web application firewall"] },
  { concept: "cdn", words: ["cdn"], phrases: ["content delivery network"] },
  { concept: "vpn", words: ["vpn"], phrases: ["virtual private network"] },
  { concept: "nat", words: ["nat"], phrases: ["network address translation"] },
  { concept: "apim", words: ["apim"], phrases: ["api management"] },
  { concept: "sso", words: ["sso"], phrases: ["single sign on"] },
  { concept: "jit", words: ["jit"], phrases: ["just in time access"] },
  { concept: "dlp", words: ["dlp"], phrases: ["data loss prevention"] },
  {
    concept: "mdm",
    words: ["mdm"],
    phrases: ["mobile device management"],
  },
  {
    concept: "mam",
    words: ["mam"],
    phrases: ["mobile application management"],
  },
  {
    concept: "sla",
    words: ["sla", "slas"],
    phrases: ["service level agreement"],
  },
  {
    concept: "iaas",
    words: ["iaas"],
    phrases: ["infrastructure as a service"],
  },
  { concept: "paas", words: ["paas"], phrases: ["platform as a service"] },
  { concept: "saas", words: ["saas"], phrases: ["software as a service"] },
  { concept: "iac", words: ["iac"], phrases: ["infrastructure as code"] },
  { concept: "kql", words: ["kql"], phrases: ["kusto query language"] },
  { concept: "tls", words: ["tls"], phrases: ["transport layer security"] },
  { concept: "gpo", words: ["gpo", "gpos"], phrases: ["group policy object"] },
  {
    concept: "alm",
    words: ["alm"],
    phrases: ["application lifecycle management"],
  },
  {
    concept: "emu",
    words: ["emu", "emus"],
    phrases: ["enterprise managed user"],
  },
  { concept: "pat", words: ["pat"], phrases: ["personal access token"] },
  {
    concept: "entra-id",
    words: ["aad"],
    phrases: [
      "azure active directory",
      "azure ad",
      "microsoft entra id",
      "entra id",
    ],
  },
];
