export const DEFAULT_TEMPORARY_ORG_FALLBACKS = deepFreeze({
  person: {
    fdId: "1j5e6gebgwkw1tvw1jqie81aeqnhg302viw0",
    fdName: "AI迁移默认人",
    fdOrgType: 8
  },
  organization: {
    fdId: "1jt85rk85w23welrpw2s3uh4pvsr8ru35dw0",
    fdName: "AI迁移默认部门",
    fdOrgType: 2
  },
  group: {
    fdId: "1jt85gq4uw23well7w25q9bmdj729u82tmw0",
    fdName: "AI迁移默认群组",
    fdOrgType: 16
  },
  post: {
    fdId: "1jt85eh5hw23welj9w3jq4nba1522lpc3tw0",
    fdName: "AI迁移默认岗位",
    fdOrgType: 4
  }
});

export function resolveTemporaryOrgFallbacks(fallbackFdIds = {}) {
  return deepFreeze(Object.fromEntries(
    Object.entries(DEFAULT_TEMPORARY_ORG_FALLBACKS).map(([kind, fallback]) => [kind, {
      ...fallback,
      fdId: configuredFdId(fallbackFdIds?.[kind]) || fallback.fdId
    }])
  ));
}

function configuredFdId(value) {
  if (typeof value !== "string") return undefined;
  return value.trim() || undefined;
}

function deepFreeze(value) {
  Object.values(value).forEach((entry) => Object.freeze(entry));
  return Object.freeze(value);
}
