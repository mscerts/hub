import { DISCORD_URL } from "@data/constants";

// An array of links for navigation bar
const navBarLinks = [
  { name: "Home", url: "/" },
  { name: "Wiki", url: "/wiki/" },
  { name: "News", url: "/news/" },
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
      { name: "Contact", url: "/contact" },
    ],
  },
  {
    section: "Community",
    links: [
      { name: "r/O365Certification", url: "https://www.reddit.com/r/O365Certification/" },
      { name: "r/SCICertifications", url: "https://www.reddit.com/r/SCICertifications/" },
      { name: "r/AzureCertifications", url: "https://www.reddit.com/r/AzureCertifications/" },
      { name: "Discord Server", url: DISCORD_URL },
    ],
  },
];
// An object of links for social icons
const socialLinks = {
  discord: DISCORD_URL,
  reddit: "https://www.reddit.com/r/O365Certification/",
  github: "https://github.com/mscerts/hub",
};

export default {
  navBarLinks,
  footerLinks,
  socialLinks,
};