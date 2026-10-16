// Exact finite trigger predicate; provenance in primary-contract.json.
(function(items,key){var i=items,r=key;return i.every(function(e){return"main"===e.type||"single"===e.tableType})&&i.some(function(e){return r.split(".").slice(-1)[0]===e.fieldName});})
