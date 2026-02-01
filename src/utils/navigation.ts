// An array of links for navigation bar
const navBarLinks = [
  { name: "Home", url: "/" },
  { name: "Wiki", url: "/wiki/" },
  { name: "Blog", url: "/blog/" },
  { name: "Vouchers", url: "/vouchers/" },
  { name: "Labs", url: "/labs/" },
//  { name: "Certifications", url: "#" },
];
// An array of links for footer
const footerLinks = [
  {
    section: "Resources",
    links: [
      { name: "Study Materials", url: "/wiki" },
      { name: "Labs", url: "/labs/" },
      { name: "Contributing", url: "/contributing/" },
      { name: "Privacy Policy", url: "/privacy" },
    ],
  },
  {
    section: "Community",
    links: [
      { name: "r/O365Certification", url: "https://www.reddit.com/r/O365Certification/" },
      { name: "r/SCICertifications", url: "https://www.reddit.com/r/SCICertifications/" },
      { name: "r/AzureCertifications", url: "https://www.reddit.com/r/AzureCertifications/" },
      { name: "Discord Server", url: "https://discord.gg/microsoft-certification-study-group-676990910176821270" },
    ],
  },
];
// An object of links for social icons
const socialLinks = {
  discord: "https://discord.gg/microsoft-certification-study-group-676990910176821270",
  reddit: "https://www.reddit.com/r/O365Certification/",
  github: "https://github.com/mscerts/hub",
};

export default {
  navBarLinks,
  footerLinks,
  socialLinks,
};