import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  collectAddressConditionOrgNames,
  resolveConditionOrgs,
  SIT_CONDITION_ORG_FALLBACKS
} from "../../src/executor/condition-org-resolver.js";

describe("resolveConditionOrgs", () => {
  it("collects organization names from address-field contains conditions", () => {
    const names = collectAddressConditionOrgNames({
      form: {
        fields: [{
          id: "fd_req_dept",
          title: "需求人部门",
          componentId: "xform-address",
          sourceProps: { designerType: "address" }
        }, {
          id: "fd_seller",
          title: "合同卖方",
          componentId: "xform-input",
          sourceProps: { designerType: "inputText" }
        }]
      },
      workflow: {
        edges: [{
          id: "L1",
          condition: {
            targetText: "$字符串.包含$($fd_req_dept$, \"南方服务中心\") || $字符串.包含$($fd_seller$, \"欧洲\")"
          }
        }, {
          id: "L2",
          condition: {
            targetText: "!($字符串.包含$($fd_req_dept$, \"北方服务中心\"))"
          }
        }]
      }
    });

    assert.deepEqual([...names].sort(), ["北方服务中心", "南方服务中心"]);
  });

  it("resolves unique organization matches into runtime conditionOrgByName", async () => {
    const client = {
      async searchOrg(key) {
        if (key === "南方服务中心") {
          return [{ fdId: "org-south", fdName: "南方服务中心", fdOrgType: 2, fdNo: "S001" }];
        }
        if (key === "模糊部门") {
          return [
            { fdId: "a", fdName: "模糊部门", fdOrgType: 2 },
            { fdId: "b", fdName: "模糊部门", fdOrgType: 2 }
          ];
        }
        return [];
      }
    };

    const result = await resolveConditionOrgs({
      form: {
        fields: [{
          id: "fd_req_dept",
          componentId: "xform-address",
          sourceProps: { designerType: "address" }
        }]
      },
      workflow: {
        edges: [{
          condition: {
            targetText: "$字符串.包含$($fd_req_dept$, \"南方服务中心\") || $字符串.包含$($fd_req_dept$, \"模糊部门\") || $字符串.包含$($fd_req_dept$, \"不存在\")"
          }
        }]
      }
    }, { client });

    assert.equal(result.resolvedCount, 1);
    assert.equal(result.nameCount, 3);
    assert.deepEqual(result.unresolvedNames.sort(), ["不存在", "模糊部门"]);
    assert.equal(result.fallbackCount, 0);
    assert.deepEqual(result.dsl.runtime.conditionOrgByName, {
      南方服务中心: { fdId: "org-south", fdName: "南方服务中心", fdOrgType: 2, fdNo: "S001" }
    });
  });

  it("applies SIT curl sample orgs when unresolved on p-sit.onewo.com", async () => {
    const elementCalls = [];
    const client = {
      async searchOrg() {
        return [];
      },
      async getElementInfo(targets) {
        elementCalls.push(targets);
        return SIT_CONDITION_ORG_FALLBACKS.filter((fallback) => targets.includes(fallback.fdId));
      }
    };

    const result = await resolveConditionOrgs({
      form: {
        fields: [{
          id: "fd_req_dept",
          componentId: "xform-address",
          sourceProps: { designerType: "address" }
        }]
      },
      workflow: {
        edges: [{
          condition: {
            targetText: "$字符串.包含$($fd_req_dept$, \"南方服务中心\") || $字符串.包含$($fd_req_dept$, \"北方服务中心\") || $字符串.包含$($fd_req_dept$, \"海外服务中心\") || $字符串.包含$($fd_req_dept$, \"海外业务中心\")"
          }
        }]
      }
    }, {
      client,
      targetBaseUrl: "https://p-sit.onewo.com"
    });

    assert.equal(result.resolvedCount, 0);
    assert.equal(result.fallbackCount, 4);
    assert.deepEqual(result.unresolvedNames, []);
    assert.deepEqual(result.fallbackNames.sort(), ["北方服务中心", "南方服务中心", "海外业务中心", "海外服务中心"]);
    assert.deepEqual(elementCalls, [[SIT_CONDITION_ORG_FALLBACKS[0].fdId]]);
    assert.deepEqual(result.dsl.runtime.conditionOrgByName.南方服务中心, SIT_CONDITION_ORG_FALLBACKS[0]);
    assert.deepEqual(result.dsl.runtime.conditionOrgByName.北方服务中心, SIT_CONDITION_ORG_FALLBACKS[0]);
    assert.deepEqual(result.dsl.runtime.conditionOrgByName.海外服务中心, SIT_CONDITION_ORG_FALLBACKS[0]);
    assert.deepEqual(result.dsl.runtime.conditionOrgByName.海外业务中心, SIT_CONDITION_ORG_FALLBACKS[0]);
  });

  it("applies the same condition-org fallback on the Shanghai Electric POC origin", async () => {
    const client = {
      async searchOrg() {
        return [];
      },
      async getElementInfo(targets) {
        return SIT_CONDITION_ORG_FALLBACKS.filter((fallback) => targets.includes(fallback.fdId));
      }
    };

    const result = await resolveConditionOrgs({
      form: {
        fields: [{
          id: "fd_req_dept",
          componentId: "xform-address",
          sourceProps: { designerType: "address" }
        }]
      },
      workflow: {
        edges: [{
          condition: {
            targetText: "$字符串.包含$($fd_req_dept$, \"南方服务中心\")"
          }
        }]
      }
    }, {
      client,
      targetBaseUrl: "http://mkpaaspoc.shanghai-electric.com"
    });

    assert.equal(result.fallbackCount, 1);
    assert.deepEqual(result.dsl.runtime.conditionOrgByName.南方服务中心, SIT_CONDITION_ORG_FALLBACKS[0]);
  });

  it("fails closed when the SIT condition fallback is not a current department", async () => {
    const client = {
      async searchOrg() {
        return [];
      },
      async getElementInfo(targets) {
        return targets.map((fdId) => ({ fdId, fdName: "错误人员兜底", fdOrgType: 8 }));
      }
    };

    await assert.rejects(
      resolveConditionOrgs({
        form: {
          fields: [{
            id: "fd_req_dept",
            componentId: "xform-address",
            sourceProps: { designerType: "address" }
          }]
        },
        workflow: {
          edges: [{
            condition: {
              targetText: "$字符串.包含$($fd_req_dept$, \"南方服务中心\")"
            }
          }]
        }
      }, {
        client,
        targetBaseUrl: "https://p-sit.onewo.com"
      }),
      (error) => error?.issues?.some((issue) => issue.reason === "fallback_target_not_department")
    );
  });
});
