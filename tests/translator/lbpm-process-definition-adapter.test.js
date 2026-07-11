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

  it("preserves retry loops instead of rejecting cyclic graphs", () => {
    const process = [
      '<process fdId="process-with-retry">',
      "<nodes>",
      '<startNode id="N1" name="开始"/>',
      '<reviewNode id="N2" name="过账"/>',
      '<autoBranchNode id="N3" name="是否成功"/>',
      '<endNode id="N4" name="结束"/>',
      "</nodes>",
      "<lines>",
      '<line id="L1" startNodeId="N1" endNodeId="N2"/>',
      '<line id="L2" startNodeId="N2" endNodeId="N3"/>',
      '<line id="L3" startNodeId="N3" endNodeId="N2" name="失败重试"/>',
      '<line id="L4" startNodeId="N3" endNodeId="N4" name="成功"/>',
      "</lines>",
      "</process>"
    ].join("");
    const xml = `
      <java>
        <object>
          <void method="put">
            <string>fdContent</string>
            <string>${encodeXml(process)}</string>
          </void>
        </object>
      </java>
    `;
    const graph = parseLbpmProcessDefinitionXml(xml);

    assert.deepEqual(graph.topologicalOrder, ["N1", "N2", "N3", "N4"]);
    assert.equal(graph.edges.length, 4);
    assert.equal(graph.edges.find((edge) => edge.id === "L3").target, "N2");
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

  it("associates current root node-definition handlers without losing organization evidence", () => {
    const xml = handlerEntityFixture();
    const result = translateLbpmProcessDefinitionXml(xml);
    const reviewNode = result.workflow.nodes.find((node) => node.id === "N2");

    assert.deepEqual(reviewNode.handlerEntities, [{
      id: "legacy-post-id",
      name: "部门负责人岗位",
      orgType: 4,
      class: "com.landray.kmss.sys.organization.model.SysOrgPost",
      parent: "示例部门",
      index: 0
    }]);
    assert.deepEqual(reviewNode.optionalHandlerEntities, [{
      id: "legacy-person-id",
      name: "示例人员",
      orgType: 8,
      class: "com.landray.kmss.sys.organization.model.SysOrgPerson",
      parent: "示例部门",
      index: 1,
      loginName: "000001"
    }]);
    assert.deepEqual(result.workflow.process.privilegerEntities, [{
      id: "legacy-privileger-id",
      name: "流程管理员岗位",
      orgType: 4,
      class: "com.landray.kmss.sys.organization.model.SysOrgPost",
      parent: "流程管理部",
      index: 0
    }]);
  });
});

function handlerEntityFixture() {
  const process = '<process fdId="handler-process"><nodes><startNode id="N1" name="开始"/><reviewNode id="N2" name="审批" handlerIds="stale-person-id" handlerNames="旧人员缓存"/><endNode id="N3" name="结束"/></nodes><lines><line id="L1" startNodeId="N1" endNodeId="N2"/><line id="L2" startNodeId="N2" endNodeId="N3"/></lines></process>';
  return `
    <java>
      <object class="java.util.HashMap">
        <void method="put">
          <string>nodeDefinitionHandlers</string>
          <object class="java.util.ArrayList">
            ${handlerEntry("00", "privilegerIds", 0, {
              id: "legacy-privileger-id",
              name: "流程管理员岗位",
              orgType: 4,
              className: "com.landray.kmss.sys.organization.model.SysOrgPost",
              parent: "流程管理部"
            })}
            ${handlerEntry("N2", "handlerIds", 0, {
              id: "legacy-post-id",
              name: "部门负责人岗位",
              orgType: 4,
              className: "com.landray.kmss.sys.organization.model.SysOrgPost",
              parent: "示例部门"
            })}
            ${handlerEntry("N2", "optHandlerIds", 1, {
              id: "legacy-person-id",
              name: "示例人员",
              orgType: 8,
              className: "com.landray.kmss.sys.organization.model.SysOrgPerson",
              parent: "示例部门",
              loginName: "000001"
            })}
          </object>
        </void>
        <void method="put"><string>fdContent</string><string>${encodeXml(process)}</string></void>
      </object>
    </java>
  `;
}

function handlerEntry(factId, attribute, index, handler) {
  return `
    <void method="add">
      <object class="java.util.HashMap">
        <void method="put"><string>fdFactId</string><string>${factId}</string></void>
        <void method="put"><string>fdAttribute</string><string>${attribute}</string></void>
        <void method="put"><string>fdIndex</string><int>${index}</int></void>
        <void method="put">
          <string>fdHandler</string>
          <object class="java.util.HashMap">
            <void method="put"><string>fdId</string><string>${handler.id}</string></void>
            <void method="put"><string>fdName</string><string>${handler.name}</string></void>
            <void method="put"><string>fdOrgType</string><int>${handler.orgType}</int></void>
            <void method="put"><string>class</string><string>${handler.className}</string></void>
            <void method="put"><string>hbmParent.fdName</string><string>${handler.parent}</string></void>
            ${handler.loginName ? `<void method="put"><string>fdLoginName</string><string>${handler.loginName}</string></void>` : ""}
          </object>
        </void>
      </object>
    </void>
  `;
}

function encodeXml(value) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;");
}
