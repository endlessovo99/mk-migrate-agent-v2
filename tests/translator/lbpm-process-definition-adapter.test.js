import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseLbpmProcessDefinitionXml, translateLbpmProcessDefinitionXml } from "../../src/translator/lbpm-process-definition-adapter.js";

const sourcePath = "tests/fixtures/source/route-validation-lbpm/route-validation_LbpmProcessDefinition.xml";

describe("translateLbpmProcessDefinitionXml", () => {
  it("parses process fdContent into a directed acyclic graph", () => {
    const xml = readFileSync(sourcePath, "utf8");
    const graph = parseLbpmProcessDefinitionXml(xml);

    assert.deepEqual(graph.topologicalOrder, ["N1", "N2", "N3", "N4"]);
    assert.deepEqual(graph.nodes.map((node) => [node.id, node.type, node.name]), [
      ["N1", "startNode", "开始节点"],
      ["N2", "draftNode", "起草节点"],
      ["N3", "reviewNode", "审批节点"],
      ["N4", "endNode", "结束节点"]
    ]);

    const reviewNode = graph.nodes.find((node) => node.id === "N3");
    assert.equal(reviewNode.attributes.handlerIds, "handler-1");
    assert.equal(reviewNode.attributes.handlerNames, "审批人");
    assert.equal(reviewNode.definition.attributes.canModifyFlow, "false");
    assert.match(reviewNode.definition.sourceXml, /operations refId="op-review"/);
    assert.match(reviewNode.sourceXml, /^<reviewNode\b/);

    const conditionalEdge = graph.edges.find((edge) => edge.id === "L2");
    assert.equal(conditionalEdge.source, "N2");
    assert.equal(conditionalEdge.target, "N3");
    assert.equal(conditionalEdge.condition, "$fd_type$ == \"A\"");
    assert.equal(conditionalEdge.displayCondition, "$类型$ == \"类型A\"");
    assert.equal(conditionalEdge.attributes.priority, "0");
    assert.match(conditionalEdge.sourceXml, /^<line\b/);
  });

  it("translates process metadata into workflow DSL", () => {
    const xml = readFileSync(sourcePath, "utf8");
    const result = translateLbpmProcessDefinitionXml(xml, { sourcePath });

    assert.equal(result.source.kind, "lbpm-process-definition-xml");
    assert.equal(result.source.fdId, "route-validation-process-id");
    assert.equal(result.source.templateId, "route-validation-template-id");
    assert.equal(result.source.lbpmTemplateId, "route-validation-lbpm-template-id");
    assert.equal(result.workflow.process.modelKey, "reviewMainDoc");
    assert.equal(result.workflow.edges.length, 3);
  });

  it("keeps comparison operators inside line conditions", () => {
    const xml = `
      <java>
        <object>
          <void method="put">
            <string>fdContent</string>
            <string>&lt;process fdId=&quot;process-with-comparisons&quot; description=&quot;templateId=template-with-comparisons&quot;&gt;&lt;nodes&gt;&lt;startNode id=&quot;N1&quot; name=&quot;开始&quot;/&gt;&lt;endNode id=&quot;N2&quot; name=&quot;结束&quot;/&gt;&lt;/nodes&gt;&lt;lines&gt;&lt;line id=&quot;L1&quot; startNodeId=&quot;N1&quot; endNodeId=&quot;N2&quot; condition=&quot;$amount$ &lt; 10&quot; disCondition=&quot;$金额$ &gt; 10&quot;/&gt;&lt;/lines&gt;&lt;/process&gt;</string>
          </void>
        </object>
      </java>
    `;
    const graph = parseLbpmProcessDefinitionXml(xml);

    assert.deepEqual(graph.topologicalOrder, ["N1", "N2"]);
    assert.equal(graph.edges[0].condition, "$amount$ < 10");
    assert.equal(graph.edges[0].displayCondition, "$金额$ > 10");
  });
});
