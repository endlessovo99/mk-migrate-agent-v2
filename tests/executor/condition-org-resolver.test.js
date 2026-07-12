import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  collectAddressConditionOrgNames,
  collectAddressConditionOrgFdNos,
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

  it("collects organization fdNo codes from address-field fdNo.equals conditions", () => {
    const fdNos = collectAddressConditionOrgFdNos({
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
            targetText: "$fd_req_dept$.fdNo.equals(\"ROUTE-ORG-001\") || $fd_seller$.fdNo.equals(\"IGNORE\")"
          }
        }]
      }
    });

    assert.deepEqual([...fdNos], ["ROUTE-ORG-001"]);
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

  it("resolves address condition organization numbers into runtime conditionOrgByFdNo", async () => {
    const client = {
      async searchOrg(key) {
        return key === "ROUTE-ORG-001"
          ? [{ fdId: "org-example", fdName: "示例组织", fdOrgType: 2, fdNo: key }]
          : [];
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
            targetText: "$fd_req_dept$.fdNo.equals(\"ROUTE-ORG-001\")"
          }
        }]
      }
    }, { client, targetBaseUrl: "https://example.test" });

    assert.equal(result.resolvedCount, 1);
    assert.equal(result.fdNoCount, 1);
    assert.deepEqual(result.unresolvedFdNos, []);
    assert.deepEqual(result.dsl.runtime.conditionOrgByFdNo, {
      "ROUTE-ORG-001": {
        fdId: "org-example",
        fdName: "示例组织",
        fdOrgType: 2,
        fdNo: "ROUTE-ORG-001"
      }
    });
  });

  it("fails closed when an organization number cannot be resolved outside fallback origins", async () => {
    for (const candidates of [
      [],
      [{ fdId: "org-other", fdName: "其他组织", fdOrgType: 2, fdNo: "ROUTE-ORG-OTHER" }]
    ]) {
      const client = {
        async searchOrg() {
          return candidates;
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
                targetText: "$fd_req_dept$.fdNo.equals(\"ROUTE-ORG-MISSING\")"
              }
            }]
          }
        }, {
          client,
          targetBaseUrl: "https://example.test"
        }),
        (error) => error?.stage === "resolveConditionOrgs" &&
          error?.issues?.some((issue) => issue.reason === "fd_no_not_found")
      );
    }
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

  it("uses the configured organization fallback fdId for unresolved conditions", async () => {
    const organizationFdId = "configured-condition-organization-id";
    const configuredOrganization = {
      fdId: organizationFdId,
      fdName: "配置条件兜底组织",
      fdOrgType: 2
    };
    const elementCalls = [];
    const client = {
      async searchOrg() {
        return [];
      },
      async getElementInfo(targets) {
        elementCalls.push(targets);
        return targets.includes(organizationFdId) ? [configuredOrganization] : [];
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
      targetBaseUrl: "http://oa-dev.shanghai-electric.com:8088",
      fallbackFdIds: { organization: organizationFdId }
    });

    assert.equal(result.fallbackCount, 1);
    assert.deepEqual(elementCalls, [[organizationFdId]]);
    assert.deepEqual(result.dsl.runtime.conditionOrgByName.南方服务中心, configuredOrganization);
  });

  it("uses the configured organization fallback when condition org search fails on allowed origins", async () => {
    const organizationFdId = "configured-condition-organization-id";
    const configuredOrganization = {
      fdId: organizationFdId,
      fdName: "配置条件兜底组织",
      fdOrgType: 2
    };
    const client = {
      async searchOrg() {
        throw new Error("请求有误");
      },
      async getElementInfo(targets) {
        return targets.includes(organizationFdId) ? [configuredOrganization] : [];
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
            targetText: "$字符串.包含$($fd_req_dept$, \"市场拓展部\")"
          }
        }]
      }
    }, {
      client,
      targetBaseUrl: "http://oa-dev.shanghai-electric.com:8088",
      fallbackFdIds: { organization: organizationFdId }
    });

    assert.equal(result.fallbackCount, 1);
    assert.deepEqual(result.fallbackNames, ["市场拓展部"]);
    assert.deepEqual(result.searchFailures.map((issue) => issue.reason), ["search_failed"]);
    assert.deepEqual(result.dsl.runtime.conditionOrgByName.市场拓展部, configuredOrganization);
  });

  it("keeps condition org search failures blocking outside fallback origins", async () => {
    const client = {
      async searchOrg() {
        throw new Error("请求有误");
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
              targetText: "$字符串.包含$($fd_req_dept$, \"市场拓展部\")"
            }
          }]
        }
      }, {
        client,
        targetBaseUrl: "https://example.test"
      }),
      (error) => error?.stage === "resolveConditionOrgs" &&
        error?.issues?.some((issue) => issue.reason === "search_failed")
    );
  });

  it("fails closed when the SIT condition fallback is not a current department", async () => {
    const configuredOrganizationId = "configured-wrong-type-organization-id";
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
        targetBaseUrl: "https://p-sit.onewo.com",
        fallbackFdIds: { organization: configuredOrganizationId }
      }),
      (error) => error?.issues?.some((issue) => issue.reason === "fallback_target_not_department")
    );
  });
});
