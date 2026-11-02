/** QAS native form AJAX and person-info contracts observed for detail-row email hydration. */
export const DETAIL_PERSON_EMAIL_CAPABILITY = Object.freeze({
  origin: 'https://oaqas.shanghai-electric.com',
  endpoint: '/data/sys-org/sysOrgPersonInfo/getPersonInfo',
  modules: Object.freeze({
    desktop: Object.freeze({ digestKey:'@module:sys-xform/desktop/api/XFormRuntime', path:'sys-xform/desktop/api/XFormRuntime', release:'a3ec998c10af6bbce34dd6caffe4a203', sha256:'a3ee70fad7030bd66884aa39a2e28e59d3472671b0d633acd0fb05d4d48c91ba' }),
    mobile: Object.freeze({ digestKey:'@module:sys-xform/mobile/api/XFormRuntime', path:'sys-xform/mobile/api/XFormRuntime', release:'4d998c2e4de3862a836c2339c5d583dd', sha256:'73e546b0d9ce8a442e27ea4f3a30622bf2c036fcb106ffd45d81a91b728551e2' }),
    person: Object.freeze({ digestKey:'@module:sys-org/desktop/api/PersonInfoCard', path:'sys-org/desktop/api/PersonInfoCard', release:'2ad7d9a57ad7576d264a7fcd945ce8ed', sha256:'4f7dde75f0a0bbed8a8a73b5144a3286a129715bb4d8882d53d6902c53208a31' })
  })
});
export function requiresDetailPersonEmail(scripts = {}) {
  return (scripts.actions || []).some(action => typeof action.function === 'string' && action.function.includes(DETAIL_PERSON_EMAIL_CAPABILITY.endpoint));
}
