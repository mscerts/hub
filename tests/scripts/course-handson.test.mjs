import assert from "node:assert/strict";
import test from "node:test";
import { handsOnReason } from "../../scripts/lib/course-handson.mjs";

const unit = (title, path = "/training/modules/some-module/3-x", more = {}) =>
  handsOnReason({ kind: "unit", path, title, ...more });
const docs = (title, path = "/azure/some-service/some-page") =>
  handsOnReason({ kind: "docs", path, title });

test("a unit whose title has the word exercise, or starts with Lab or Simulation and a separator, is hands-on", () => {
  assert.equal(unit("Exercise - Create a virtual network"), "exercise");
  assert.equal(unit("Exercise – add groups in Microsoft Entra ID"), "exercise");
  assert.equal(unit("Optional exercise - Deploy it"), "exercise");
  assert.equal(unit("Deploy a web app exercise"), "exercise");
  assert.equal(unit("Exercise configure and deploy a thing"), "exercise");
  assert.equal(unit("Simulation - Create networks"), "simulation");
  assert.equal(unit("Lab: Configure the firewall"), "lab");
  assert.equal(unit("Lab - Configure the firewall"), "lab");
});

test("bare lab or simulation inside a title is reading, not a lab", () => {
  assert.equal(unit("Understand DLP simulation mode"), null);
  assert.equal(unit("Lab environments explained"), null);
  assert.equal(unit("Explore virtual network peering"), null);
  assert.equal(unit("Knowledge check"), null);
});

test("a guided or challenge project is hands-on, as a module and for each of its units", () => {
  assert.equal(
    handsOnReason({
      kind: "module",
      path: "/training/modules/guided-project-cost-guardrails",
      title: "Guided project: Set up cost guardrails in Azure",
    }),
    "guided project",
  );
  assert.equal(
    handsOnReason({
      kind: "module",
      path: "/training/modules/some-slug",
      title: "Challenge Project - Build a thing",
    }),
    "challenge project",
  );
  // a unit with an innocent title of a project module, known by the module's title or by its address
  assert.equal(
    unit("Introduction", "/training/modules/some-slug/1-intro", {
      moduleTitle: "Guided Project - Azure Files and Azure Blobs",
    }),
    "guided project",
  );
  assert.equal(
    unit("Introduction", "/training/modules/guided-project-x/1-intro"),
    "guided project",
  );
  // an ordinary module that has exercises in it is not hands-on as a whole
  assert.equal(
    handsOnReason({
      kind: "module",
      path: "/training/modules/configure-virtual-networks",
      title: "Configure virtual networks",
    }),
    null,
  );
});

test("a docs page that is a tutorial or a quickstart is hands-on, by its title or by its address", () => {
  assert.equal(docs("Tutorial: Filter network traffic with a network security group (NSG)"), "tutorial");
  assert.equal(docs("Quickstart - Create a Windows VM in the Azure portal"), "quickstart");
  assert.equal(docs("Log Analytics Tutorial: Query and Analyze Log Data - Azure Monitor"), "tutorial");
  // the title lost its prefix, the address kept it
  assert.equal(docs("Create template - Visual Studio Code", "/azure/azure-resource-manager/templates/quickstart-create-templates-use-visual-studio-code"), "quickstart");
  assert.equal(docs("Enable Microsoft Entra self-service password reset", "/entra/identity/authentication/tutorial-enable-sspr"), "tutorial");
  assert.equal(docs("Build policies to enforce compliance", "/azure/governance/policy/tutorials/create-and-manage"), "tutorial");
  assert.equal(docs("Create a virtual machine", "/azure/virtual-machines/windows/quick-create-portal"), "quickstart");
});

test("an ordinary documentation page, a concept or a how-to, stays in the course", () => {
  assert.equal(docs("How to manage groups", "/entra/fundamentals/how-to-manage-groups"), null);
  assert.equal(docs("What is Azure Files?", "/azure/storage/files/storage-files-introduction"), null);
  assert.equal(docs("Azure Monitor metrics aggregation and display explained", "/azure/azure-monitor/metrics/metrics-aggregation-explained"), null);
  // the tutorial rule is for documentation pages: a unit is judged by its own title
  assert.equal(unit("Tutorial overview"), null);
});

test("an Applied Skill is hands-on whatever its kind", () => {
  assert.equal(
    docs("Deploy and configure Azure Monitor", "/credentials/applied-skills/deploy-and-configure-azure-monitor"),
    "applied skill",
  );
});

test("a missing field is not a crash", () => {
  assert.equal(handsOnReason(), null);
  assert.equal(handsOnReason({ kind: "docs" }), null);
});
