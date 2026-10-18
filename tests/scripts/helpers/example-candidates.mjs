// A small, invented corner of Microsoft Learn for the candidate generator's tests: one exam (NET-100) whose
// official course is about routing and identities, a sibling exam's module (NET-700), an identity governance
// module of a third exam, modules no course uses (SAP, Cosmos DB, a deeper dive), and a documentation catalog
// with pages that each trip one hard filter. Nothing here says what a real exam covers.
import { buildScopeMap } from "../../../scripts/lib/course-scope.mjs";

const mod = (slug, title, products, units, extra = {}) => ({
  uid: `learn.${slug}`,
  path: `/training/modules/${slug}`,
  title,
  products,
  units,
  unitUrls: units.map((_, i) => `/training/modules/${slug}/${i + 1}-unit`),
  unitSig: `sig-${slug}`,
  ...extra,
});

const link = (path, text) => ({
  kind: "docs",
  path,
  text,
  section: "Learn more",
});
const record = (slug, links) => ({
  path: `/training/modules/${slug}`,
  unitSig: `sig-${slug}`,
  unit: `/training/modules/${slug}/9-summary`,
  unitTitle: "Summary",
  harvestedAt: "2026-10-17",
  links,
});

const course = (number, uids) => ({
  course_number: number,
  title: number,
  url: `https://learn.microsoft.com/en-us/training/courses/${number.toLowerCase()}/`,
  last_modified: "2026-01-01T00:00:00Z",
  study_guide: uids.map((uid) => ({ uid, type: "learningPath" })),
});

const doc = (path, title, description = "") => ({
  title,
  url: `https://learn.microsoft.com${path}`,
  product: null,
  subproduct: null,
  description,
});

/** Fresh objects on every call, so a test can change them. */
export function candidateWorld() {
  const catalog = {
    modules: [
      mod(
        "manage-traffic-routes",
        "Manage and control traffic flow with routes",
        ["Virtual Network"],
        [
          "Introduction",
          "What are routes?",
          "Create custom user-defined routes",
          "Summary",
        ],
      ),
      mod(
        "configure-peering",
        "Configure virtual network peering",
        ["Virtual Network"],
        ["Introduction", "Peer networks", "Summary"],
      ),
      mod(
        "create-identities",
        "Create and manage identities and external users",
        ["entra-id"],
        ["Introduction", "Create users", "Invite external users", "Summary"],
      ),
      mod(
        "route-between-networks",
        "Create user-defined routes between virtual networks",
        ["Virtual Network"],
        ["Introduction", "Connect networks", "Summary"],
      ),
      mod(
        "plan-entitlement",
        "Plan entitlement management for external users",
        ["entra-id"],
        ["Introduction", "Onboard external users", "Summary"],
      ),
      mod(
        "sap-routes",
        "User-defined routes for SAP landscapes",
        ["SAP"],
        ["Introduction"],
      ),
      mod(
        "cosmos-routes",
        "User-defined routes for Cosmos DB",
        ["Cosmos DB"],
        ["Introduction"],
      ),
      // tagged like the exam's own product, but about SAP: only the pages that best match its title say so
      mod(
        "mislabeled-sap",
        "SAP landscapes: user-defined routes",
        ["Virtual Network"],
        ["Introduction"],
      ),
      mod(
        "routes-deep-dive",
        "User-defined routes deep dive",
        ["Virtual Network"],
        ["Introduction", "Next hop types"],
      ),
      mod(
        "gone-routes",
        "Retired user-defined routes lab",
        ["Virtual Network"],
        ["Introduction"],
      ),
    ],
    removed: [{ path: "/training/modules/gone-routes" }],
  };
  const learningPaths = [
    {
      uid: "learn.path-net",
      path: "/training/paths/net",
      modules: [
        "/training/modules/manage-traffic-routes",
        "/training/modules/configure-peering",
        "/training/modules/create-identities",
      ],
    },
    {
      uid: "learn.path-700",
      path: "/training/paths/net-700",
      modules: ["/training/modules/route-between-networks"],
    },
    {
      uid: "learn.path-gov",
      path: "/training/paths/gov",
      modules: ["/training/modules/plan-entitlement"],
    },
  ];
  const courses = [
    course("NET-100T00", ["learn.path-net"]),
    course("NET-700T00", ["learn.path-700"]),
    course("GOV-300T00", ["learn.path-gov"]),
  ];
  const moduleLinks = {
    lastChecked: "2026-10-17T00:00:00Z",
    modules: [
      record("manage-traffic-routes", [
        link(
          "/azure/virtual-network/virtual-networks-udr-overview",
          "Virtual network traffic routing",
        ),
        link(
          "/azure/virtual-network/tutorial-create-route-table",
          "Route network traffic with a route table",
        ),
        link("/azure/community/join", "User-defined routes community"),
      ]),
      record("configure-peering", [
        link(
          "/azure/virtual-network/virtual-network-peering-overview",
          "Virtual network peering",
        ),
        {
          kind: "training",
          path: "/training/modules/route-between-networks",
          text: "Create user-defined routes between virtual networks",
          section: "Learn more with self-paced training",
        },
        link("/azure/community/join", "User-defined routes community"),
      ]),
      record("create-identities", [
        link("/entra/identity/users/manage", "Manage users"),
        link("/azure/community/join", "User-defined routes community"),
      ]),
      record("route-between-networks", [
        link(
          "/azure/virtual-network/virtual-networks-overview",
          "Virtual networks",
        ),
      ]),
      record("plan-entitlement", [
        link(
          "/entra/id-governance/entitlement-management-overview",
          "Entitlement management",
        ),
        link(
          "/entra/id-governance/entitlement-management-external-users",
          "Onboard external users",
        ),
      ]),
    ],
  };
  const docs = [
    doc(
      "/azure/virtual-network/virtual-networks-udr-overview",
      "Virtual network traffic routing",
      "Learn about user-defined routes and system routes",
    ),
    doc(
      "/azure/virtual-network/tutorial-create-route-table",
      "Tutorial: Route network traffic with a route table",
    ),
    doc(
      "/azure/virtual-network/manage-route-table",
      "Create, change, or delete a route table",
      "Manage user-defined routes in a route table",
    ),
    doc("/azure/sap/workloads/routes", "User-defined routes for SAP workloads"),
    doc(
      "/azure/sap/workloads/landscape-routes",
      "User-defined routes for SAP landscapes",
    ),
    doc(
      "/azure/sap/workloads/landscape-udr",
      "SAP landscapes and user-defined routes",
    ),
    doc(
      "/azure/sap/workloads/landscape-hub",
      "User-defined routes in an SAP landscapes hub",
    ),
    ...[1, 2, 3, 4, 5].map((n) =>
      doc(
        `/azure/virtual-network/customers/udr-${n}`,
        `User-defined routes for customers ${n}`,
      ),
    ),
    doc(
      "/power-platform/admin/routes",
      "User-defined routes for Power Platform",
    ),
    doc(
      "/azure/network-watcher/next-hop-overview",
      "Next hop for user-defined routes",
      "Find the next hop of a route",
    ),
    doc(
      "/entra/id-governance/entitlement-management-external-users",
      "Onboard external users with entitlement management",
    ),
    doc("/previous-versions/azure/virtual-network/udr", "User-defined routes"),
    doc(
      "/azure/virtual-network/udr-deprecated",
      "User-defined routes (retired)",
    ),
    doc(
      "/azure/virtual-network/udr-moved",
      "User-defined routes in virtual networks",
    ),
    doc("/azure/virtual-network/udr-ghost", "User-defined routes ghost"),
    doc(
      "/azure/virtual-network/udr-ja",
      "ユーザー定義ルートの概要 user-defined routes",
    ),
    {
      title: "User-defined routes on GitHub",
      url: "https://docs.github.com/azure/udr",
      product: null,
      subproduct: null,
      description: "",
    },
    doc("/azure/community/join", "Join the community"),
  ];
  const docPaths = new Set(
    docs
      .filter((d) => d.url.startsWith("https://learn.microsoft.com"))
      .map((d) => new URL(d.url).pathname)
      .filter((p) => p !== "/azure/virtual-network/udr-ghost")
      .concat([
        "/azure/virtual-network/virtual-network-peering-overview",
        "/azure/virtual-network/virtual-networks-overview",
        "/entra/identity/users/manage",
        "/entra/id-governance/entitlement-management-overview",
      ]),
  );
  const redirects = [
    {
      from: "/azure/virtual-network/udr-moved",
      to: "/azure/virtual-network/udr-new",
      kind: "moved",
    },
  ];
  return {
    catalog,
    learningPaths,
    courses,
    moduleLinks,
    docs,
    docPaths,
    redirects,
  };
}

export const guideOf = (tasks, hash = "guide-hash") => ({
  hash,
  domains: [
    {
      title: "Networking",
      groups: [
        {
          title: "Configure virtual networks",
          tasks: tasks.map((text, i) => ({
            key: `networking/configure/t${i}`,
            text,
          })),
        },
      ],
    },
  ],
});

export const scopeOf = (world = candidateWorld(), code = "NET-100") =>
  buildScopeMap({
    code,
    courses: world.courses,
    learningPaths: world.learningPaths,
    modules: world.catalog.modules,
    moduleLinks: world.moduleLinks,
  });
