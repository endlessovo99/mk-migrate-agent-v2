import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { REDACTED_CREDENTIAL_VALUE } from "../../src/credential-material.js";
import { checkDraft, checkExecute } from "../../src/dsl/checks.js";
import { createTrustedMigrationDsl } from "../../src/dsl/trust.js";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { translateLbpmProcessDefinitionXml } from "../../src/translator/lbpm-process-definition-adapter.js";
import { prepareSample } from "../helpers/persistence.js";

const fixtureDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "../fixtures/translator/workflow-credential-redaction"
);
const lbpmPath = join(fixtureDir, "credential-redaction_LbpmProcessDefinition.xml");
const HEADER_SECRET = "fixture-fake-header-secret";
const QUERY_SECRET = "fixture-fake-query-secret";
const REDACTED_PATHS = [
  "/attributes/content/headers/0/fieldValue",
  "/attributes/content/restfulUrl/query/X-Fixture-App-Auth-Key"
];

describe("workflow credential redaction", () => {
  it("redacts structured robot credentials from attributes and retained source XML", () => {
    const xml = readFileSync(lbpmPath, "utf8");
    assert.equal(xml.includes(HEADER_SECRET), true);
    assert.equal(xml.includes(QUERY_SECRET), true);

    const translated = translateLbpmProcessDefinitionXml(xml, { sourcePath: lbpmPath });
    const robot = translated.workflow.nodes.find((node) => node.id === "RX20");
    const config = JSON.parse(robot.definition.attributes.content);
    const url = new URL(config.restfulUrl);
    const serialized = JSON.stringify(translated);

    assert.equal(serialized.includes(HEADER_SECRET), false);
    assert.equal(serialized.includes(QUERY_SECRET), false);
    assert.equal(robot.definition.sourceXml.includes(HEADER_SECRET), false);
    assert.equal(robot.definition.sourceXml.includes(QUERY_SECRET), false);
    assert.equal(config.headers[0].fieldName, "X-Fixture-App-Auth-Key");
    assert.equal(config.headers[0].fieldValue, REDACTED_CREDENTIAL_VALUE);
    assert.deepEqual(config.headers[1], { fieldName: "X-Trace", fieldValue: "keep-me" });
    assert.equal(url.searchParams.get("X-Fixture-App-Auth-Key"), REDACTED_CREDENTIAL_VALUE);
    assert.equal(url.searchParams.get("mode"), "keep");
    assert.equal(config.preAuthorization, "keep-policy");
    assert.match(robot.definition.sourceXml, /fixture-operation/);
    assert.deepEqual(translated.review.warnings, [{
      code: "source.workflow.credential_redacted",
      message: "Credential material was redacted from workflow source evidence.",
      path: "/workflow/nodes/RX20/definition",
      details: { redactedPaths: REDACTED_PATHS }
    }]);
  });

  it("keeps Source Draft, DSL, and native persistence output credential-free", () => {
    const { sourceDraft, dslDraft, trusted } = buildArtifacts();
    const sourceWarning = sourceDraft.issues.find((issue) =>
      issue.code === "source.workflow.credential_redacted"
    );
    const dslWarning = dslDraft.review.warnings.find((warning) =>
      warning.code === "source.workflow.credential_redacted"
    );

    assert.deepEqual(sourceWarning, {
      level: "warning",
      code: "source.workflow.credential_redacted",
      message: "Credential material was redacted from workflow source evidence.",
      sourcePath: "/workflow/nodes/RX20/definition",
      evidence: { redactedPaths: REDACTED_PATHS }
    });
    assert.deepEqual(dslWarning, {
      code: "source.workflow.credential_redacted",
      message: "Credential material was redacted from workflow source evidence.",
      path: "/workflow/nodes/RX20/definition",
      details: { redactedPaths: REDACTED_PATHS }
    });
    assert.equal(checkDraft(dslDraft).ok, true);
    assert.equal(checkDraft(dslDraft).status, "needs_manual");
    assert.equal(checkExecute(trusted).ok, true);

    for (const artifact of [sourceDraft, dslDraft, trusted]) {
      const serialized = JSON.stringify(artifact);
      assert.equal(serialized.includes(HEADER_SECRET), false);
      assert.equal(serialized.includes(QUERY_SECRET), false);
    }

    const prepared = prepareSample(trusted);
    const persisted = JSON.stringify(prepared.update);
    assert.equal(persisted.includes(HEADER_SECRET), false);
    assert.equal(persisted.includes(QUERY_SECRET), false);
    assert.equal(persisted.includes(REDACTED_CREDENTIAL_VALUE), true);
    assert.equal(persisted.includes("keep-me"), true);
    assert.equal(persisted.includes("mode=keep"), true);
  });

  it("rejects hand-authored DSL that restores a sensitive header value", () => {
    const { trusted } = buildArtifacts();
    const injected = structuredClone(trusted);
    const robot = injected.workflow.nodes.find((node) => node.id === "RX20");
    const config = JSON.parse(robot.definition.attributes.content);
    config.headers[0].fieldValue = HEADER_SECRET;
    robot.definition.attributes.content = JSON.stringify(config);

    const result = checkExecute(injected);
    assert.equal(result.ok, false);
    assert.equal(result.diagnostics.some((item) =>
      item.code === "dsl.workflow.credential_material_forbidden" &&
      item.path.endsWith("/definition/attributes/content/headers/0/fieldValue")
    ), true);
    assert.equal(JSON.stringify(result).includes(HEADER_SECRET), false);
  });

  it("rejects hand-authored DSL that restores a sensitive URL query value", () => {
    const { trusted } = buildArtifacts();
    const injected = structuredClone(trusted);
    const robot = injected.workflow.nodes.find((node) => node.id === "RX20");
    const config = JSON.parse(robot.definition.attributes.content);
    const url = new URL(config.restfulUrl);
    url.searchParams.set("X-Fixture-App-Auth-Key", QUERY_SECRET);
    config.restfulUrl = url.toString();
    robot.definition.attributes.content = JSON.stringify(config);

    const result = checkExecute(injected);
    assert.equal(result.ok, false);
    assert.equal(result.diagnostics.some((item) =>
      item.code === "dsl.workflow.credential_material_forbidden" &&
      item.path.endsWith("/definition/attributes/content/restfulUrl/query/X-Fixture-App-Auth-Key")
    ), true);
    assert.equal(JSON.stringify(result).includes(QUERY_SECRET), false);
  });

  it("rejects credential material on every persisted workflow source-evidence path", () => {
    const cases = [
      {
        name: "node sourceXml",
        code: "dsl.workflow.raw_source_xml_forbidden",
        expectedPath: "/workflow/nodes/0/sourceXml",
        inject(dsl) {
          dsl.workflow.nodes[0].sourceXml = `<startNode Authorization="${HEADER_SECRET}" />`;
        }
      },
      {
        name: "node definition sourceXml",
        code: "dsl.workflow.raw_source_xml_forbidden",
        expectedPath: "/workflow/nodes/0/definition/sourceXml",
        inject(dsl) {
          dsl.workflow.nodes[0].definition = {
            ...(dsl.workflow.nodes[0].definition || {}),
            sourceXml: `<startNode Authorization="${HEADER_SECRET}" />`
          };
        }
      },
      {
        name: "edge attributes",
        code: "dsl.workflow.credential_material_forbidden",
        expectedPath: "/workflow/edges/0/attributes/robotConfig/headers/0/value",
        inject(dsl) {
          dsl.workflow.edges[0].attributes = {
            robotConfig: {
              headers: [{ name: "Authorization", value: HEADER_SECRET }]
            }
          };
        }
      },
      {
        name: "edge sourceXml",
        code: "dsl.workflow.raw_source_xml_forbidden",
        expectedPath: "/workflow/edges/0/sourceXml",
        inject(dsl) {
          dsl.workflow.edges[0].sourceXml = `<line Authorization="${HEADER_SECRET}" />`;
        }
      },
      {
        name: "edge credential username",
        code: "dsl.workflow.credential_material_forbidden",
        expectedPath: "/workflow/edges/0/attributes/credentials/username",
        inject(dsl) {
          dsl.workflow.edges[0].attributes = {
            credentials: { username: HEADER_SECRET }
          };
        }
      }
    ];

    for (const testCase of cases) {
      const { trusted } = buildArtifacts();
      testCase.inject(trusted);
      const result = checkExecute(trusted);
      assert.equal(result.ok, false, testCase.name);
      assert.equal(result.diagnostics.some((item) =>
        item.code === testCase.code && item.path === testCase.expectedPath
      ), true, testCase.name);
      assert.equal(JSON.stringify(result).includes(HEADER_SECRET), false, testCase.name);
    }
  });
});

function buildArtifacts() {
  const sourceDraft = cleanSourceFile(fixtureDir);
  const dslDraft = draftSourceDraft(sourceDraft);
  const trusted = createTrustedMigrationDsl(sourceDraft, dslDraft, {
    externalAgentReviewed: true,
    reviewerName: "credential-redaction-test",
    checkedAt: "2026-07-15T00:00:00.000Z"
  });
  return { sourceDraft, dslDraft, trusted };
}
